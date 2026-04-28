import React, { useState } from "react"
import { Box, Text, useInput } from "ink"
import { match } from "ts-pattern"

export interface LogViewerSearchInputProps {
  /** Initial query — restored when re-opened mid-session. */
  initialQuery: string
  /** Fired on Enter — caller scans forward for the next match. */
  onSubmit(query: string): void
  /** Fired on Esc — closes the widget. */
  onClose(): void
}

/**
 * Single-line search input rendered at the bottom of `LogViewerPanel`. While
 * mounted it captures every keypress, so the panel-level `useInput` is
 * disabled (`isActive` gated on `!searchActive`) to avoid contention.
 *
 * Keys:
 *   - Enter: submit the current query → caller jumps to next match.
 *   - Esc:   close the widget; caller clears state.
 *   - Backspace / Delete: trim the last character.
 *   - Any printable input: appended to the query.
 */
export function LogViewerSearchInput(
  props: LogViewerSearchInputProps
): React.ReactElement {
  const [draft, setDraft] = useState(props.initialQuery)
  useInput((input, key) => {
    match({ input, key })
      .with({ key: { return: true } }, () => props.onSubmit(draft))
      .with({ key: { escape: true } }, () => props.onClose())
      .with({ key: { backspace: true } }, () =>
        setDraft(d => d.slice(0, -1))
      )
      .with({ key: { delete: true } }, () => setDraft(d => d.slice(0, -1)))
      .otherwise(() => {
        // Printable chars only — Ink delivers them as `input`. Reject control
        // sequences (Ctrl+_ / Meta+_) so they don't pollute the query buffer.
        if (input.length > 0 && !key.ctrl && !key.meta) {
          setDraft(d => d + input)
        }
      })
  })
  return (
    <Box marginTop={1}>
      <Text>/</Text>
      <Text>{draft}</Text>
      <Text dimColor>{LogViewerSearchInput.HelpText}</Text>
    </Box>
  )
}

export namespace LogViewerSearchInput {
  /**
   * Hint text rendered to the right of the input. Mentions the `/pattern/`
   * regex affordance so users discover it without docs.
   */
  export const HelpText =
    "  [Enter find next, Esc close, /regex/ for regex]" as const
}
