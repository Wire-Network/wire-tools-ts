import { Box, Text } from "ink"

import { ResultSummary } from "@wireio/ql-shared"

import { NoLimitText } from "../../utils/index.js"

import { ResultsState, useAppSelector } from "../store/index.js"

/**
 * Engine counters, the page window and server vs wall time.
 *
 * @returns The panel element.
 */
export function StatsPanel() {
  const execution = useAppSelector(state => ResultsState.success(state.results))
  if (execution == null) return <Text dimColor>{StatsPanel.EmptyText}</Text>
  const { stats, page } = execution.result
  return (
    <Box flexDirection="column">
      <Text>
        {ResultSummary.join([
          `page: offset ${page.offset}`,
          `limit ${page.limit ?? NoLimitText}`,
          `returned ${page.returned_rows}`,
          ResultSummary.totalPart(page),
          ...(page.has_more ? [StatsPanel.MoreAvailableText] : [])
        ])}
      </Text>
      <Text>
        {ResultSummary.join([
          ResultSummary.scannedPart(stats),
          ResultSummary.matchedPart(stats),
          `groups ${stats.groups}`,
          `returned ${stats.returned_rows}`
        ])}
      </Text>
      <Text>{`raw bytes ${stats.raw_bytes}`}</Text>
      <Text>{ResultSummary.join([ResultSummary.elapsedPart(execution), `attempts ${execution.attempts}`])}</Text>
    </Box>
  )
}

/** Stats constants. */
export namespace StatsPanel {
  /** Shown before the first successful run. */
  export const EmptyText = "no stats"
  /** Shown when the server reports more rows. */
  export const MoreAvailableText = "more available"
}
