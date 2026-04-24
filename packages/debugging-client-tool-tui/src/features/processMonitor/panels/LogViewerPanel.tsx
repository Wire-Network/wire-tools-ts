import React, { useEffect, useState } from "react"
import { Box, Text, useFocus, useInput, useWindowSize } from "ink"
import { match } from "ts-pattern"
import type { PanelComponentProps } from "../../../components/PanelComponent.js"
import { VirtualList } from "../../../components/VirtualList.js"
import { useService } from "../../../services/ServiceContext.js"
import { ServiceId } from "../../../services/ServiceId.js"
import {
  useAppDispatch,
  useAppSelector
} from "../../../store/Store.js"
import { selectLogViewer } from "../../../store/processMonitor/ProcessMonitorSelectors.js"
import {
  setLogViewerFollow,
  setLogViewerOffset
} from "../../../store/processMonitor/ProcessMonitorSlice.js"
import {
  LogTailingEvent,
  LogTailingService,
  type LogTailingRuntime
} from "../LogTailingService.js"

/** Approximate chrome height (borders + header + status) subtracted from terminal rows. */
const ChromeLines = 14

function LogViewerBody(_: PanelComponentProps): React.ReactElement {
  const viewer = useAppSelector(selectLogViewer),
    dispatch = useAppDispatch(),
    { rows } = useWindowSize(),
    viewportHeight = Math.max(3, rows - ChromeLines),
    tailing = useService<LogTailingService>(ServiceId.LogTailing),
    { isFocused } = useFocus({ id: LogViewerPanel.id }),
    [runtime, setRuntime] = useState<LogTailingRuntime>(tailing.getRuntime())

  useEffect(() => {
    const onUpdate = () => setRuntime(tailing.getRuntime())
    tailing.on(LogTailingEvent, onUpdate)
    return () => {
      tailing.off(LogTailingEvent, onUpdate)
    }
  }, [tailing])

  /** Pin offset to tail when follow mode is on. */
  const effectiveOffset = viewer.follow
    ? Math.max(0, runtime.totalLines - viewportHeight)
    : viewer.offset

  useInput(
    (input, key) => {
      if (!viewer.path) return
      match({ input, key })
        .with({ key: { upArrow: true } }, () =>
          dispatch(setLogViewerOffset(effectiveOffset - 1))
        )
        .with({ key: { downArrow: true } }, () =>
          dispatch(setLogViewerOffset(effectiveOffset + 1))
        )
        .with({ key: { pageUp: true } }, () =>
          dispatch(setLogViewerOffset(effectiveOffset - viewportHeight))
        )
        .with({ key: { pageDown: true } }, () =>
          dispatch(setLogViewerOffset(effectiveOffset + viewportHeight))
        )
        .with({ input: "g" }, () => dispatch(setLogViewerOffset(0)))
        .with({ input: "G" }, () =>
          dispatch(
            setLogViewerOffset(
              Math.max(0, runtime.totalLines - viewportHeight)
            )
          )
        )
        .with({ input: "F" }, () =>
          dispatch(setLogViewerFollow(!viewer.follow))
        )
        .otherwise(() => {})
    },
    { isActive: isFocused }
  )

  if (!viewer.path) {
    return (
      <Text dimColor>
        Select a node in the Process Monitor panel (Enter) to view its log.
      </Text>
    )
  }
  if (runtime.indexing) {
    return <Text dimColor>Indexing {viewer.path}...</Text>
  }
  return (
    <Box flexDirection="column">
      <Text dimColor>
        {viewer.path} — line {effectiveOffset + 1} of {runtime.totalLines}
        {viewer.follow ? " [FOLLOW]" : ""} [↑/↓ scroll, PgUp/PgDn page, g/G
        top/bot, F follow]
      </Text>
      <VirtualList
        totalItems={runtime.totalLines}
        offset={effectiveOffset}
        viewportHeight={viewportHeight}
        fetchRange={(from, count) => tailing.readWindow(from, count)}
        renderItem={(line, i) => <Text key={i}>{line}</Text>}
      />
    </Box>
  )
}

/** Virtual log viewer — offset-controlled window, backed by `LogTailingService`. */
export function LogViewerPanel(props: PanelComponentProps) {
  return <LogViewerBody {...props} />
}
LogViewerPanel.id = "process-monitor:log-viewer" as const
LogViewerPanel.title = "Log Viewer" as const
