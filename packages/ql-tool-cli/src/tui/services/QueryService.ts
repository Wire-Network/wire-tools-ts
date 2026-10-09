import Path from "node:path"

import { identity } from "lodash"
import { match } from "ts-pattern"

import {
  OutputFormat,
  QueryErrorKind,
  QueryExecutionStatus,
  QueryHistoryEntry,
  QueryPager,
  ResultRenderer,
  ResultSummary,
  ResultView,
  type ConnectionProfile,
  type QueryEngineClient,
  type QueryExecution,
  type QueryExecutionSuccess
} from "@wireio/ql-shared"
import { getLogger, NestedError } from "@wireio/shared"

import { ErrorPrinter, OutputWriter, QueryInputArgs, type CliContext } from "../../cli/index.js"
import { clampIndex } from "../../utils/index.js"
import { KeyBindings, TuiAction } from "../keys/index.js"
import { MessageLevel, ResultsActions, ResultsState, UiActions, type TuiStore } from "../store/index.js"
import type { CatalogService } from "./CatalogService.js"
import type { PersistenceService } from "./PersistenceService.js"
import type { TuiService, TuiServiceStartContext } from "./TuiService.js"
import { TuiServiceId } from "./TuiServiceId.js"
import type { TuiServiceRegistry } from "./TuiServiceRegistry.js"

const log = getLogger(__filename)

/** Which rows an export covers. */
export enum ExportScope {
  /** The loaded page, with the client view (sort / filter) applied. */
  page = "page",
  /** Every row: ONE request without limit (one snapshot, capped by query-max-result-rows). */
  all = "all"
}

/** One export. */
export interface ExportRequest {
  /** Output format. */
  format: OutputFormat
  /** Rows covered. */
  scope: ExportScope
  /** Header row on/off. */
  header: boolean
  /** Destination file. */
  file: string
}

/**
 * Executes queries for the TUI through one {@link QueryEngineClient} per
 * profile: one AbortController per run (a new run or Esc abandons the previous
 * one — the server keeps working), server paging from the results slice,
 * history recording, SCHEMA_CHANGED → catalog invalidation, and export.
 */
export class QueryService implements TuiService {
  /** Service id. */
  readonly id = TuiServiceId.query
  /** Records history and invalidates the catalog. */
  readonly dependsOn: readonly TuiServiceId[] = [TuiServiceId.store, TuiServiceId.persistence, TuiServiceId.catalog]
  /** The in-flight run (resolved when idle) — quit awaits it so the history append lands. */
  running: Promise<void> = Promise.resolve()
  private store: TuiStore = null
  private registry: TuiServiceRegistry = null
  private client: QueryEngineClient = null
  private controller: AbortController = null

  /**
   * @param context - The CLI context (client factory).
   */
  constructor(readonly context: CliContext) {}

  /**
   * Create the client of the boot profile.
   *
   * @param context - Store, profile and registry.
   */
  async start(context: TuiServiceStartContext): Promise<void> {
    this.store = context.store
    this.registry = context.registry
    this.client = this.context.createClient(context.profile)
  }

  /** Abandon any in-flight run. */
  async stop(): Promise<void> {
    this.cancel()
    await this.running
  }

  /**
   * Switch to another profile (any in-flight run is abandoned).
   *
   * @param profile - The new connection.
   */
  useProfile(profile: ConnectionProfile): void {
    this.cancel()
    this.client = this.context.createClient(profile)
  }

  /**
   * Run `query` (default: the editor text) from page 1.
   *
   * @param query - SQL text.
   * @returns Resolves when the run settles.
   */
  run(query: string = this.store.getState().editor.buffer.text): Promise<void> {
    const text = query.trim()
    if (text.length === 0) {
      this.store?.dispatch(UiActions.message(MessageLevel.warn, QueryInputArgs.EmptyQueryText))
      return Promise.resolve()
    }
    this.store.dispatch(ResultsActions.pageSelected(QueryPager.FirstPage))
    return this.execute(text)
  }

  /**
   * Fetch server page `page` of the last run (clamped to 1…page count).
   *
   * @param page - 1-based page.
   * @returns Resolves when the run settles.
   */
  fetchPage(page: number): Promise<void> {
    const { results } = this.store.getState()
    if (results.query.length === 0) return Promise.resolve()
    const clamped = clampIndex(page - QueryPager.FirstPage, ResultsState.pageCount(results)) + QueryPager.FirstPage
    this.store.dispatch(ResultsActions.pageSelected(clamped))
    return this.execute(results.query)
  }

  /**
   * Retry the failed run: the same SQL with the same page / window (offered
   * only while {@link ResultsState.canRetry} holds — a retryable failure and
   * nothing running).
   *
   * @returns Resolves when the run settles.
   */
  retry(): Promise<void> {
    const { results } = this.store.getState()
    if (!ResultsState.canRetry(results)) {
      this.store?.dispatch(UiActions.message(MessageLevel.warn, QueryService.NotRetryableText))
      return Promise.resolve()
    }
    return this.execute(results.query)
  }

  /** Abandon the in-flight run ("Stop": the server keeps working). */
  cancel(): void {
    this.controller?.abort()
  }

  /** Whether a run is in flight. */
  get busy(): boolean {
    return this.controller != null
  }

  /**
   * Export rows to a file.
   *
   * @param request - Format, scope, header and file.
   * @returns The written file path.
   * @throws NestedError when there is nothing to export or the all-rows request fails.
   */
  async exportResult(request: ExportRequest): Promise<string> {
    const { results } = this.store.getState(),
      execution =
        request.scope === ExportScope.all
          ? QueryService.assertSuccess(await this.client.execute(results.query, { offset: 0 }))
          : ResultsState.success(results)
    if (execution == null) throw new NestedError(QueryService.NothingToExportText)
    const view = ResultView.create(execution.result, ResultsState.viewOptions(results, execution.result.columns)),
      text = ResultRenderer.render(request.format, { execution, view, range: view.fullRange() }, { header: request.header }),
      file = Path.resolve(request.file)
    OutputWriter.write(text, file)
    this.store?.dispatch(UiActions.message(MessageLevel.info, `exported ${view.rowCount} rows (${request.format}) to ${file}`))
    return file
  }

  /** Execute `query` with the results slice's window; publish, record, react. */
  private execute(query: string): Promise<void> {
    this.cancel()
    const controller = new AbortController(),
      window = ResultsState.requestWindow(this.store.getState().results)
    this.controller = controller
    this.store.dispatch(ResultsActions.runStarted(query))
    this.running = this.client
      .execute(query, { ...window, signal: controller.signal })
      .then(execution => this.finish(controller, execution))
      .catch(error => {
        if (controller === this.controller) this.controller = null
        log.error(`query run failed unexpectedly: ${NestedError.toError(error).message}`)
        this.store?.dispatch(UiActions.message(MessageLevel.error, `query run failed: ${NestedError.toError(error).message}`))
      })
    return this.running
  }

  /** Handle a settled run (a superseded run only records history). */
  private finish(controller: AbortController, execution: QueryExecution): void {
    this.recordHistory(execution)
    if (controller !== this.controller) return
    this.controller = null
    this.store.dispatch(ResultsActions.runFinished(execution))
    match(execution)
      .with({ status: QueryExecutionStatus.success }, success => this.store?.dispatch(UiActions.message(MessageLevel.info, QueryService.summary(success))))
      .with({ status: QueryExecutionStatus.failure }, failed => {
        this.store?.dispatch(UiActions.message(MessageLevel.error, ErrorPrinter.failureLines(failed.failure, failed.query).join("\n")))
        if (ResultsState.isRetryable(failed.failure)) this.store?.dispatch(UiActions.message(MessageLevel.info, QueryService.RetryableText))
        if (failed.failure.data?.kind === QueryErrorKind.SCHEMA_CHANGED) {
          this.registry.get<CatalogService>(TuiServiceId.catalog).invalidate()
        }
      })
      .exhaustive()
  }

  /** Append the history record (best-effort — `PersistenceService.appendHistory`). */
  private recordHistory(execution: QueryExecution): void {
    this.registry
      .get<PersistenceService>(TuiServiceId.persistence)
      .appendHistory(QueryHistoryEntry.of(execution, this.store.getState().connection.profile.name, new Date()))
  }
}

/** Constants and pure helpers of {@link QueryService}. */
export namespace QueryService {
  /** Messages-tab line after a retryable failure. */
  export const RetryableText = `retryable — ${KeyBindings.labelOf(TuiAction.retry)} retries the same query and window`
  /** Messages-tab line when Retry is pressed without a retryable failure. */
  export const NotRetryableText = "nothing to retry: the last run did not fail retryably"
  /** Refusal of an export before any successful run (the service throws it; the workbench warns with it). */
  export const NothingToExportText = "nothing to export: run a query first"

  /**
   * One-line success summary: rows of total, block, server / wall time.
   *
   * @param execution - The success.
   * @returns The summary.
   */
  export function summary(execution: QueryExecutionSuccess): string {
    const { page, state } = execution.result
    return ResultSummary.join([ResultSummary.rowsPart(page), ResultSummary.blockPart(state), ResultSummary.elapsedPart(execution)])
  }

  /**
   * The success of an execution.
   *
   * @param execution - The outcome.
   * @returns The success.
   * @throws NestedError carrying the failure.
   */
  export function assertSuccess(execution: QueryExecution): QueryExecutionSuccess {
    return match(execution)
      .with({ status: QueryExecutionStatus.success }, identity)
      .with({ status: QueryExecutionStatus.failure }, failed => {
        throw new NestedError(`query failed: ${failed.failure.message}`, { context: { failure: failed.failure } })
      })
      .exhaustive()
  }
}
