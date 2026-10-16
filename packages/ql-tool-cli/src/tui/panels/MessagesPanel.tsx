import { Box, Text } from "ink"
import { match } from "ts-pattern"

import { WindowedList } from "../components/index.js"
import { TuiColorRole, TuiPalette } from "../editor/index.js"
import { MessageLevel, useAppSelector } from "../store/index.js"

/** Props of {@link MessagesPanel}. */
export interface MessagesPanelProps {
  /** Visible lines. */
  height: number
}

/**
 * Run outcomes, errors and notices, newest last.
 *
 * @param props - Height.
 * @returns The panel element.
 */
export function MessagesPanel({ height }: MessagesPanelProps) {
  const messages = useAppSelector(state => state.ui.messages),
    visible = WindowedList.window(messages, messages.length - 1, height)
  if (messages.length === 0) return <Text dimColor>{MessagesPanel.EmptyText}</Text>
  return (
    <Box flexDirection="column">
      {visible.items.map((message, index) => (
        <Text key={visible.offset + index} color={MessagesPanel.colorOf(message.level)} wrap="truncate">
          {`${message.at.slice(MessagesPanel.TimeStart, MessagesPanel.TimeEnd)} ${message.text}`}
        </Text>
      ))}
    </Box>
  )
}

/** Messages constants. */
export namespace MessagesPanel {
  /** Shown without messages. */
  export const EmptyText = "no messages"
  /** `HH:MM:SS` slice of an ISO time. */
  export const TimeStart = 11
  /** End of the `HH:MM:SS` slice. */
  export const TimeEnd = 19

  /**
   * Ink color of a level.
   *
   * @param level - The level.
   * @returns The color (undefined = default).
   */
  export function colorOf(level: MessageLevel): string {
    return match(level)
      .with(MessageLevel.info, () => undefined)
      .with(MessageLevel.warn, () => TuiPalette[TuiColorRole.warning])
      .with(MessageLevel.error, () => TuiPalette[TuiColorRole.error])
      .exhaustive()
  }
}
