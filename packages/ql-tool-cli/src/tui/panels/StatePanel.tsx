import { Box, Text } from "ink"

import { ResultSummary } from "@wireio/ql-shared"

import { ResultsState, useAppSelector } from "../store/index.js"

/**
 * The single block snapshot the page reflects (each page is its own snapshot).
 *
 * @returns The panel element.
 */
export function StatePanel() {
  const execution = useAppSelector(state => ResultsState.success(state.results))
  if (execution == null) return <Text dimColor>{StatePanel.EmptyText}</Text>
  const { state, source } = execution.result
  return (
    <Box flexDirection="column">
      <Text>{`source ${source.owners.join(",")}.${source.table}`}</Text>
      <Text>{`chain ${state.chain_id}`}</Text>
      <Text>{`block ${state.block_num} ${state.block_id}`}</Text>
      <Text>{ResultSummary.join([`time ${state.block_time}`, `captured ${state.captured_at}`])}</Text>
      <Text>
        {ResultSummary.join([`read mode ${state.read_mode}`, ResultSummary.irreversiblePart(state), ResultSummary.syncedLabel(state)])}
      </Text>
      {state.abis.map(abi => (
        <Text key={abi.owner} dimColor>{`abi ${abi.owner} ${abi.hash}`}</Text>
      ))}
    </Box>
  )
}

/** State constants. */
export namespace StatePanel {
  /** Shown before the first successful run. */
  export const EmptyText = "no snapshot"
}
