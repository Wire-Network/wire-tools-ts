import { Box, Text } from "ink"

import { WindowedList } from "../components/index.js"
import { selectResultJsonLines, useAppSelector } from "../store/index.js"

/** Props of {@link ResultsJsonPanel}. */
export interface ResultsJsonPanelProps {
  /** Visible lines. */
  height: number
}

/**
 * The loaded page as pretty JSON (the same renderer as `wql --format json`),
 * scrolled by its OWN line offset (↑↓ while the JSON tab shows — the grid cursor
 * indexes rows, not JSON lines).
 *
 * @param props - Height.
 * @returns The panel element.
 */
export function ResultsJsonPanel({ height }: ResultsJsonPanelProps) {
  const lines = useAppSelector(state => selectResultJsonLines(state.results)),
    jsonLine = useAppSelector(state => state.results.jsonLine)
  if (lines.length === 0) return <Text dimColor>{ResultsJsonPanel.EmptyText}</Text>
  const offset = WindowedList.clampOffset(jsonLine, height, lines.length)
  return (
    <Box flexDirection="column">
      {lines.slice(offset, offset + height).map((line, index) => (
        <Text key={offset + index} wrap="truncate">
          {line}
        </Text>
      ))}
    </Box>
  )
}

/** JSON panel constants. */
export namespace ResultsJsonPanel {
  /** Shown before the first successful run. */
  export const EmptyText = "no results"
}
