import { Box, Text } from "ink"
import { match } from "ts-pattern"

import { PageSizeMode, ResultSummary } from "@wireio/ql-shared"

import { NoLimitText } from "../../utils/index.js"

import { KeyBindings, TuiAction } from "../keys/index.js"
import { FocusArea, QueryRunStatus, ResultsState, useAppSelector } from "../store/index.js"
import { SchemaTreePanel } from "./SchemaTreePanel.js"

/**
 * Run status (a retryable failure says so), `page N/M · rows · block`, server
 * vs wall time, and the key hints of the focused area.
 *
 * @returns The status element.
 */
export function StatusBar() {
  const results = useAppSelector(state => state.results),
    focus = useAppSelector(state => state.ui.focus)
  return (
    <Box justifyContent="space-between">
      <Text>{StatusBar.statusText(results)}</Text>
      <Text dimColor>{StatusBar.hintsFor(focus)}</Text>
    </Box>
  )
}

/** Status text constants and derivations (pure). */
export namespace StatusBar {
  /** Status part of a retryable failure. */
  export const RetryableText = `retryable (${KeyBindings.labelOf(TuiAction.retry)} retry)`
  /** Paging part in All mode. */
  export const AllPagesText = "page All"
  /** Status part pointing at the Messages tab. */
  export const SeeMessagesText = "see Messages"
  /** Hints per focused area (every chord label comes from a binding, or — for the schema tree's raw keys — from the tree's own input constants). */
  export const Hints: Readonly<Record<FocusArea, string>> = {
    [FocusArea.schema]: SchemaTreePanel.KeysHint,
    [FocusArea.editor]: ResultSummary.join([
      `${KeyBindings.labelOf(TuiAction.run)} run`,
      `${KeyBindings.labelOf(TuiAction.format)} format`,
      `${KeyBindings.labelOf(TuiAction.window)} window`
    ]),
    [FocusArea.grid]: ResultSummary.join([
      `${KeyBindings.labelOf(TuiAction.previousPage)}/${KeyBindings.labelOf(TuiAction.nextPage)} page`,
      `${KeyBindings.labelOf(TuiAction.sortColumn)} sort`,
      `${KeyBindings.labelOf(TuiAction.filterColumn)} filter`,
      `${KeyBindings.labelOf(TuiAction.columns)} columns`,
      `${KeyBindings.labelOf(TuiAction.find)} find`,
      `${KeyBindings.labelOf(TuiAction.inspect)} inspect`,
      `${KeyBindings.labelOf(TuiAction.cyclePageSize)} size`
    ])
  }

  /**
   * The status line of the results state.
   *
   * @param results - Results state.
   * @returns The line.
   */
  export function statusText(results: ResultsState): string {
    const execution = ResultsState.success(results),
      paging = pagingText(results)
    return match(results.status)
      .with(QueryRunStatus.idle, () => "ready")
      .with(QueryRunStatus.running, () => ResultSummary.join(["running…", paging]))
      .with(QueryRunStatus.failed, () =>
        ResultSummary.join(["failed", ...(ResultsState.canRetry(results) ? [RetryableText] : []), SeeMessagesText])
      )
      .with(QueryRunStatus.succeeded, () =>
        ResultSummary.join([
          paging,
          ResultSummary.rowsPart(execution.result.page),
          ResultSummary.blockPart(execution.result.state),
          ResultSummary.elapsedPart(execution)
        ])
      )
      .exhaustive()
  }

  /**
   * The paging part of the status: the explicit window, `page All`, or `page N/M (size S)`.
   *
   * @param results - Results state.
   * @returns The part.
   */
  export function pagingText(results: ResultsState): string {
    return match<ResultsState, string>(results)
      .when(({ window }) => window != null, ({ window }) => `window offset ${window.offset} limit ${window.limit ?? NoLimitText}`)
      .with({ mode: PageSizeMode.all }, () => AllPagesText)
      .otherwise(() => `page ${results.page}/${ResultsState.pageCount(results)} (size ${results.pageSize})`)
  }

  /**
   * Key hints of the focused area.
   *
   * @param focus - Focused area.
   * @returns The hints.
   */
  export function hintsFor(focus: FocusArea): string {
    return Hints[focus]
  }
}
