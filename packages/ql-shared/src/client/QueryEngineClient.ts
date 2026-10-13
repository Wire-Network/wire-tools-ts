import { asOption } from "@3fv/prelude-ts"
import { defaults, identity } from "lodash"
import { match, P } from "ts-pattern"

import {
  JsonRPCProtocol,
  JsonRPCTransport,
  JsonRPCTransportError,
  JsonRPCTransportStage
} from "@wireio/cluster-tool-shared"
import { getLogger, NestedError } from "@wireio/shared"

import { QueryEngineError, QueryFailureError, QueryTransportError } from "../errors/index.js"
import { QueryText } from "../grammar/QueryText.js"
import type { ConnectionProfile } from "../profiles/index.js"
import {
  QueryEngineMethod,
  QueryEngineRPC,
  QueryErrorKind,
  QueryRequestCodec,
  QueryResponseEnvelopeCodec,
  type QueryColumn,
  type QueryEngineErrorBody,
  type QueryRequest,
  type QueryRequestParams,
  type QueryResponseEnvelope,
  type QueryResult
} from "../protocol/index.js"
import { QueryExecutionStatus, QueryFailureKind, type QueryExecution } from "./QueryExecution.js"
import type { QueryFailure } from "./QueryFailure.js"
import { QueryRetryPolicy } from "./QueryRetryPolicy.js"

const log = getLogger(__filename)

/** Caller-tunable behavior (all optional). */
export interface QueryEngineClientOptions {
  /** Fetch implementation (tests inject a stub). */
  fetchProvider?: typeof fetch
  /** Request-id generator (deterministic in tests). */
  createRequestId?: () => string
}

/** Resolved behavior. */
export interface QueryEngineClientConfig
  extends Required<QueryEngineClientOptions> {}

/** Per-call options — every `query.execute` request option plus cancellation. */
export interface ExecuteOptions {
  /** Caller cancellation ("Stop" abandons the request; the server keeps working). */
  signal?: AbortSignal
  /** Request `limit` (page size). Omitted/null → no per-call limit (SQL LIMIT / server cap still apply). */
  limit?: number
  /** Request `offset`. Omitted/null → 0. */
  offset?: number
  /** Request `timeout_ms` (may only lower query-timeout-ms). Omitted → the profile's `queryTimeoutMs`, else the server default. */
  timeoutMs?: number
}

/** Everything one execution's attempts share. */
interface ExecutionContext {
  query: string
  requestId: string
  params: QueryRequestParams
  options: ExecuteOptions
  started: number
}

/** The probed `result` member of an undecoded response (schema-version check). */
interface ResultVersionProbe {
  schema_version?: unknown
}

/** The probed shape of an undecoded response (schema-version check). */
interface EnvelopeVersionProbe {
  result?: ResultVersionProbe
}

/**
 * Defaults for {@link QueryEngineClientOptions}. `fetch` is bound — an unbound
 * global fetch throws "Illegal invocation" in browsers.
 *
 * @returns The default options.
 */
export function createQueryEngineClientDefaultOptions(): Partial<QueryEngineClientOptions> {
  return {
    fetchProvider: globalThis.fetch.bind(globalThis),
    createRequestId: () => crypto.randomUUID()
  }
}

/**
 * JSON-RPC client for `POST /v1/query/execute`. {@link execute} never throws for
 * engine/transport/cancellation outcomes — it returns them as a
 * {@link QueryExecution}.
 */
export class QueryEngineClient {
  /** Resolved behavior. */
  readonly config: QueryEngineClientConfig

  /**
   * @param profile - The connection (endpoint, timeouts, retries).
   * @param options - Fetch / request-id overrides.
   */
  constructor(
    readonly profile: ConnectionProfile,
    options: QueryEngineClientOptions = {}
  ) {
    this.config = defaults(
      { ...options },
      createQueryEngineClientDefaultOptions()
    ) as QueryEngineClientConfig
  }

  /** Fully-qualified execute URL (the one derivation). */
  get executeURL(): string {
    return new URL(QueryEngineRPC.ExecutePath, this.profile.endpoint).toString()
  }

  /**
   * Execute one SELECT; auto-retries per {@link QueryRetryPolicy}; a caller abort
   * yields a `cancelled` failure.
   *
   * @param query - The SQL text.
   * @param options - Paging window, server deadline and cancellation.
   * @returns The execution outcome.
   * @throws When the request itself is invalid (e.g. a negative limit) — a caller bug, not an outcome.
   */
  async execute(
    query: string,
    options: ExecuteOptions = {}
  ): Promise<QueryExecution> {
    const context: ExecutionContext = {
      query,
      requestId: this.config.createRequestId(),
      params: QueryEngineClient.createRequestParams(query, options, this.profile),
      options,
      started: performance.now()
    }
    log.debug(`[${context.requestId}] query.execute: ${query}`)
    const execution = await this.runAttempt(context, 1)
    log.info(
      `[${execution.requestId}] profile=${this.profile.name} endpoint=${this.profile.endpoint} ` +
        `wallMs=${execution.wallTimeMs.toFixed(1)} attempts=${execution.attempts} outcome=${QueryEngineClient.describeOutcome(execution)}`
    )
    return execution
  }

  /**
   * `SELECT * FROM <qualified>` with request `limit: 0` — returns the VALUE-field
   * columns only (`SELECT *` omits key fields; keys come from the catalog's ABI).
   *
   * @param owner - The owner account.
   * @param table - The table name.
   * @param options - Deadline and cancellation (any limit/offset is replaced).
   * @returns The value-field columns.
   * @throws QueryFailureError carrying the execution failure (engine kind, code and retryability intact) when the describe query fails.
   */
  async describe(
    owner: string,
    table: string,
    options: ExecuteOptions = {}
  ): Promise<QueryColumn[]> {
    const execution = await this.execute(QueryText.selectAllQuery(owner, table), {
      ...options,
      limit: 0,
      offset: null
    })
    return match(execution)
      .with({ status: QueryExecutionStatus.success }, success => success.result.columns)
      .with({ status: QueryExecutionStatus.failure }, failed => {
        throw new QueryFailureError(`describe ${owner}.${table} failed: ${failed.failure.message}`, {
          failure: failed.failure,
          context: { owner, table }
        })
      })
      .exhaustive()
  }

  /** One attempt (recursing for auto-retries). */
  private async runAttempt(
    context: ExecutionContext,
    attempt: number
  ): Promise<QueryExecution> {
    try {
      const result = await this.send(context)
      return {
        status: QueryExecutionStatus.success,
        requestId: context.requestId,
        query: context.query,
        wallTimeMs: performance.now() - context.started,
        attempts: attempt,
        result
      }
    } catch (error) {
      return this.handleAttemptFailure(context, attempt, error)
    }
  }

  /** Classify a failed attempt: retry, or map it to a failure outcome. */
  private async handleAttemptFailure(
    context: ExecutionContext,
    attempt: number,
    error: unknown
  ): Promise<QueryExecution> {
    if (context.options.signal?.aborted) {
      log.info(`[${context.requestId}] cancelled by the caller`)
      return this.failed(context, attempt, QueryEngineClient.cancelledFailure())
    }
    return match(error)
      .with(P.instanceOf(QueryEngineError), async engineError => {
        const retry =
          QueryRetryPolicy.shouldAutoRetry(engineError.data) &&
          attempt <= this.profile.retries
        if (!retry) {
          return this.failed(context, attempt, QueryEngineClient.engineFailure(engineError))
        }
        log.warn(
          `[${context.requestId}] ${engineError.data.kind} (retryable): ${engineError.engineMessage} — retry ${attempt}/${this.profile.retries}`
        )
        try {
          await QueryEngineClient.backoff(QueryRetryPolicy.backoffMs(attempt), context.options.signal)
        } catch (abort) {
          log.info(`[${context.requestId}] cancelled during backoff: ${String(abort)}`)
          return this.failed(context, attempt, QueryEngineClient.cancelledFailure())
        }
        return this.runAttempt(context, attempt + 1)
      })
      .with(P.instanceOf(QueryTransportError), async transportError => {
        log.warn(`[${context.requestId}] transport failure: ${transportError.detail}`)
        return this.failed(context, attempt, QueryEngineClient.transportFailure(transportError))
      })
      .otherwise(unexpected => {
        throw new NestedError("query.execute failed unexpectedly", {
          cause: unexpected,
          context: { requestId: context.requestId }
        })
      })
  }

  /** Build the failure outcome. */
  private failed(
    context: ExecutionContext,
    attempt: number,
    failure: QueryFailure
  ): QueryExecution {
    return {
      status: QueryExecutionStatus.failure,
      requestId: context.requestId,
      query: context.query,
      wallTimeMs: performance.now() - context.started,
      attempts: attempt,
      failure
    }
  }

  /** POST one request and decode the response; throws QueryEngineError / QueryTransportError. */
  private async send(context: ExecutionContext): Promise<QueryResult> {
    const { requestId, params, options } = context,
      url = this.executeURL,
      ceilingMs = QueryEngineClient.transportCeilingMs(this.profile, params.timeout_ms),
      timeoutSignal = AbortSignal.timeout(ceilingMs),
      signal = AbortSignal.any(
        [options.signal, timeoutSignal].filter(candidate => candidate != null)
      )
    let envelope: QueryResponseEnvelope
    try {
      envelope = await JsonRPCTransport.invoke<QueryRequest, QueryResponseEnvelope>({
        url,
        request: {
          jsonrpc: JsonRPCProtocol.Version,
          id: requestId,
          method: QueryEngineMethod["query.execute"],
          params
        },
        requestSerializer: QueryRequestCodec,
        responseCodec: QueryResponseEnvelopeCodec,
        fetchProvider: this.config.fetchProvider,
        signal
      })
    } catch (error) {
      throw QueryEngineClient.transportError(error, {
        ceilingMs,
        timedOut: timeoutSignal.aborted && !options.signal?.aborted
      })
    }
    return match(envelope)
      .with({ result: P.nonNullable }, success => success.result)
      .with({ error: P.nonNullable }, failed => {
        throw QueryEngineClient.engineError(failed.error, params, requestId)
      })
      .exhaustive()
  }
}

/** How a failed transport attempt ended, for {@link QueryEngineClient.transportError}. */
export interface TransportAttempt {
  /** The fetch ceiling that applied (ms). */
  ceilingMs: number
  /** Whether the client ceiling (not the caller) aborted the request. */
  timedOut: boolean
}

/** Constants and pure helpers of {@link QueryEngineClient}. */
export namespace QueryEngineClient {
  /** Added to an explicit server deadline to form the transport ceiling (transfer of an 8 MiB body). */
  export const TransportAllowanceMs = 5_000
  /** Message of a response matching neither envelope variant. */
  export const InvalidEnvelopeMessage = "invalid query.execute envelope"
  /** Message for a caller-abandoned execution. */
  export const CancelledMessage = "query cancelled"
  /** Appended to INVALID_PARAMS when the request carried paging / deadline params (engine/client skew). */
  export const UpgradeHint =
    `this node's query engine predates HTTP paging (response schema ${QueryEngineRPC.SchemaVersion}); ` +
    "upgrade nodeop to a wire-sysio build containing query_engine_plugin paging"

  /**
   * Request params: `{ query }` plus only the members actually set (a plain
   * query sends exactly `{query}`). The deadline falls back to the profile's
   * `queryTimeoutMs`.
   *
   * @param query - The SQL text.
   * @param options - Per-call window / deadline.
   * @param profile - The connection profile.
   * @returns The params object.
   */
  export function createRequestParams(
    query: string,
    options: ExecuteOptions,
    profile: ConnectionProfile
  ): QueryRequestParams {
    const { limit, offset, timeoutMs = profile.queryTimeoutMs } = options
    return {
      query,
      ...(limit != null && { limit }),
      ...(offset != null && { offset }),
      ...(timeoutMs != null && { timeout_ms: timeoutMs })
    }
  }

  /**
   * The client fetch ceiling: the profile's transport timeout, raised so it
   * always exceeds an explicit server deadline plus the transfer allowance.
   *
   * @param profile - The connection profile.
   * @param timeoutMs - The request's server deadline, if any.
   * @returns Ceiling in ms.
   */
  export function transportCeilingMs(
    profile: ConnectionProfile,
    timeoutMs: number
  ): number {
    return timeoutMs == null
      ? profile.transportTimeoutMs
      : Math.max(profile.transportTimeoutMs, timeoutMs + TransportAllowanceMs)
  }

  /**
   * Map a failed {@link JsonRPCTransport.invoke} onto a {@link QueryTransportError}:
   * a client-ceiling abort names the timeout, an envelope whose `schema_version`
   * differs from {@link QueryEngineRPC.SchemaVersion} names both versions, and
   * anything that is not a transport failure (an invalid request — a caller bug)
   * is returned unchanged for the caller to rethrow.
   *
   * @param error - What the transport threw.
   * @param attempt - The ceiling and whether it elapsed.
   * @returns The error to throw.
   */
  export function transportError(error: unknown, attempt: TransportAttempt): unknown {
    return match(error)
      .with(P.instanceOf(JsonRPCTransportError), failed =>
        new QueryTransportError(transportMessage(failed, attempt), {
          url: failed.url,
          status: failed.status,
          requestId: String(failed.requestId),
          cause: failed
        })
      )
      .otherwise(identity)
  }

  /** The client-facing message of one transport failure stage. */
  function transportMessage(failed: JsonRPCTransportError, attempt: TransportAttempt): string {
    const timeout = `transport timeout after ${attempt.ceilingMs}ms`
    return match(failed.stage)
      .with(JsonRPCTransportStage.request, () => (attempt.timedOut ? timeout : failed.detail))
      .with(JsonRPCTransportStage.read, () =>
        attempt.timedOut ? `${timeout} reading the response` : failed.detail
      )
      .with(JsonRPCTransportStage.decode, () =>
        asOption(schemaVersionOf(failed.body))
          .filter(version => version !== QueryEngineRPC.SchemaVersion)
          .map(
            version =>
              `unsupported query engine response schema_version ${String(version)}; this client requires ${QueryEngineRPC.SchemaVersion}`
          )
          .getOrElse(InvalidEnvelopeMessage)
      )
      .with(JsonRPCTransportStage.status, JsonRPCTransportStage.id, () => failed.detail)
      .exhaustive()
  }

  /** The `result.schema_version` of a parsed body (absent when the body carries none). */
  function schemaVersionOf(body: unknown): unknown {
    return (body as EnvelopeVersionProbe)?.result?.schema_version
  }

  /**
   * The typed error for an engine `error` member (INVALID_PARAMS on a paged
   * request gets the upgrade hint).
   *
   * @param body - The engine error member.
   * @param params - The params that were sent.
   * @param requestId - The request id.
   * @returns The error to throw.
   */
  export function engineError(
    body: QueryEngineErrorBody,
    params: QueryRequestParams,
    requestId: string
  ): QueryEngineError {
    const pagedRequest =
        params.limit != null || params.offset != null || params.timeout_ms != null,
      hinted = body.data.kind === QueryErrorKind.INVALID_PARAMS && pagedRequest,
      message = hinted ? `${body.message} — ${UpgradeHint}` : body.message
    return new QueryEngineError(message, { code: body.code, data: body.data, requestId })
  }

  /**
   * Serializable failure of an engine error.
   *
   * @param error - The engine error.
   * @returns The failure.
   */
  export function engineFailure(error: QueryEngineError): QueryFailure {
    return { kind: QueryFailureKind.engine, message: error.engineMessage, code: error.code, data: error.data }
  }

  /**
   * Serializable failure of a transport error.
   *
   * @param error - The transport error.
   * @returns The failure.
   */
  export function transportFailure(error: QueryTransportError): QueryFailure {
    return { kind: QueryFailureKind.transport, message: error.detail, code: null, data: null }
  }

  /**
   * Serializable failure of a caller cancellation.
   *
   * @returns The failure.
   */
  export function cancelledFailure(): QueryFailure {
    return { kind: QueryFailureKind.cancelled, message: CancelledMessage, code: null, data: null }
  }

  /**
   * One-word outcome for logs.
   *
   * @param execution - The outcome.
   * @returns `success`, the engine kind, or the failure class.
   */
  export function describeOutcome(execution: QueryExecution): string {
    return match(execution)
      .with({ status: QueryExecutionStatus.success }, success =>
        `success rows=${success.result.page.returned_rows} elapsedUs=${success.result.stats.elapsed_us}`
      )
      .with({ status: QueryExecutionStatus.failure }, failed =>
        failed.failure.data?.kind ?? failed.failure.kind
      )
      .exhaustive()
  }

  /**
   * Abort-aware delay; the timer is cleared on abort.
   *
   * @param delayMs - The delay.
   * @param signal - Optional caller signal.
   * @returns Resolves after the delay; rejects with the abort reason.
   */
  export function backoff(delayMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason)
        return
      }
      const onAbort = () => {
          clearTimeout(timer)
          reject(signal.reason)
        },
        timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort)
          resolve()
        }, delayMs)
      signal?.addEventListener("abort", onAbort, { once: true })
    })
  }
}
