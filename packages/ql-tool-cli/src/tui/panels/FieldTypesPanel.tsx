import { Box, Text } from "ink"

import { ListingEmptyCell } from "../../utils/index.js"

import { ResultsState, useAppSelector } from "../store/index.js"

/** Column separator. */
const Separator = "  "

/**
 * The result's `columns[]`: name, logical type, ABI type, nullability, encoding.
 *
 * @returns The panel element.
 */
export function FieldTypesPanel() {
  const execution = useAppSelector(state => ResultsState.success(state.results))
  if (execution == null) return <Text dimColor>{FieldTypesPanel.EmptyText}</Text>
  return (
    <Box flexDirection="column">
      <Text bold>{["name", "logical_type", "abi_type", "nullable", "encoding"].join(Separator)}</Text>
      {execution.result.columns.map(column => (
        <Text key={column.name}>
          {[column.name, column.logical_type, column.abi_type ?? ListingEmptyCell, String(column.nullable), column.encoding].join(Separator)}
        </Text>
      ))}
    </Box>
  )
}

/** Field types constants. */
export namespace FieldTypesPanel {
  /** Shown before the first successful run. */
  export const EmptyText = "no result columns"
}
