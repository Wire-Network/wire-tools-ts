import React from "react"
import { Text } from "ink"
import {
  LineRender,
  renderWithHighlight,
  sliceForHorizontalOffset
} from "../util/lineRender.js"

export interface LogViewerTextLineProps {
  /** Raw line read from the file — rendered verbatim. */
  line: string
  /** Number of leading characters dropped (horizontal scroll). */
  horizontalOffset: number
  /** Search term — substring matches are highlighted. Empty disables. */
  highlight: string
}

/** Render one plain-text log line verbatim with horizontal-offset slicing + search highlight. */
export function LogViewerTextLine(
  props: LogViewerTextLineProps
): React.ReactElement {
  const sliced = sliceForHorizontalOffset(props.line, props.horizontalOffset)
  return (
    <Text wrap={LineRender.TruncateMode}>
      {renderWithHighlight(sliced, props.highlight)}
    </Text>
  )
}
