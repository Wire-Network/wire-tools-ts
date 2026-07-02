import React, { useEffect, useState } from "react"
import { Box, Text, useFocus, useFocusManager, useInput } from "ink"
import { match } from "ts-pattern"
import { ClusterFiles } from "@wireio/debugging-shared"
import type { PanelComponentProps } from "../../../components/PanelComponent.js"
import { adjustStickyWindow } from "../../../utils/windowUtils.js"
import { useService } from "../../../services/ServiceContext.js"
import { ServiceId } from "../../../services/ServiceId.js"
import { useAppDispatch, useAppSelector } from "../../../store/Store.js"
import { selectCluster } from "../../../store/cluster/ClusterSelectors.js"
import {
  selectLogViewer,
  selectProcessMap
} from "../../../store/process-monitor/ProcessMonitorSelectors.js"
import { setLogViewerPath } from "../../../store/process-monitor/ProcessMonitorSlice.js"
import {
  PidSourceKind,
  logPathForSource,
  type PidSource
} from "@wireio/debugging-shared"
import type { ProcessMonitorService } from "../ProcessMonitorService.js"
import { LogViewerPanel } from "./LogViewerPanel.js"

/** Character glyphs for alive / dead / unknown liveness states. */
namespace StatusGlyph {
  export const Alive = "●" as const
  export const Dead = "✕" as const
  export const Unknown = "…" as const
}

type LivenessKind = "alive" | "dead" | "unknown"

/** Classify liveness for display branching. */
function classify(liveness: { alive: boolean } | undefined): LivenessKind {
  return match(liveness)
    .with({ alive: true }, () => "alive" as LivenessKind)
    .with({ alive: false }, () => "dead" as LivenessKind)
    .otherwise(() => "unknown" as LivenessKind)
}

/** Human-readable identifier shown per row. */
function identifierForSource(source: PidSource): string {
  return match(source)
    .with({ kind: PidSourceKind.Anvil }, () => "anvil")
    .with(
      { kind: PidSourceKind.SolanaValidator },
      () => "solana-test-validator"
    )
    .otherwise(s => `${s.node?.producerName ?? s.node?.nodeId ?? s.label}`)
}

/** Right-hand endpoint info; only nodeop sources expose host:port. */
function endpointForSource(source: PidSource): string {
  return source.node ? ` @ ${source.node.host}:${source.node.port}` : ""
}

function ProcessMonitorBody(_: PanelComponentProps): React.ReactElement {
  const cluster = useAppSelector(selectCluster),
    processes = useAppSelector(selectProcessMap),
    viewer = useAppSelector(selectLogViewer),
    dispatch = useAppDispatch(),
    monitor = useService<ProcessMonitorService>(ServiceId.ProcessMonitor),
    // autoFocus so the route is interactive on first paint.
    { isFocused } = useFocus({ autoFocus: true, id: ProcessMonitorPanel.id }),
    { focus } = useFocusManager(),
    sources: PidSource[] = monitor.listSources(),
    /**
     * Cursor is tracked by source LABEL, not numeric index — `listSources()`
     * re-scans the filesystem each render and a re-ordered (or temporarily
     * shorter) list would otherwise yank the highlight onto a different
     * process without a keypress.
     */
    [selectedLabel, setSelectedLabel] = useState<string | null>(null),
    cursorByLabel = sources.findIndex(s => s.label === selectedLabel),
    cursor = cursorByLabel === -1 ? 0 : cursorByLabel,
    /** A log path is currently being viewed → render in compact mode. */
    isCompact = !!viewer.path,
    windowSize = isCompact
      ? ProcessMonitorPanel.CompactRowCount
      : sources.length,
    [sliceStart, setSliceStart] = useState(0)

  // Sticky window: re-center only when the cursor leaves the viewport. With
  // the previous "always-center" behavior, every keystroke shifted the row
  // set under the cursor, which read as the list "jumping" on each press.
  useEffect(() => {
    setSliceStart(prev =>
      adjustStickyWindow(prev, cursor, sources.length, windowSize)
    )
  }, [cursor, sources.length, windowSize])

  const sliceEnd = Math.min(sources.length, sliceStart + windowSize),
    visibleSources = sources.slice(sliceStart, sliceEnd)

  /** Open the log viewer for `source` and hand focus over to the LogViewerPanel. */
  const openLog = React.useCallback(
    (source: PidSource) => {
      dispatch(setLogViewerPath(logPathForSource(source)))
      focus(LogViewerPanel.id)
    },
    [dispatch, focus]
  )

  /** Move cursor by `delta` rows, snapping to the resulting label. */
  const move = React.useCallback(
    (delta: number) => {
      if (sources.length === 0) return
      const nextIdx = Math.max(0, Math.min(sources.length - 1, cursor + delta))
      setSelectedLabel(sources[nextIdx].label)
    },
    [sources, cursor]
  )

  useInput(
    (input, key) => {
      if (sources.length === 0) return
      match({ input, key })
        .with({ input: "j" }, () => move(1))
        .with({ key: { downArrow: true } }, () => move(1))
        .with({ input: "k" }, () => move(-1))
        .with({ key: { upArrow: true } }, () => move(-1))
        .with({ input: "\r" }, () => openLog(sources[cursor]))
        .with({ key: { return: true } }, () => openLog(sources[cursor]))
        .otherwise(() => {})
    },
    { isActive: isFocused }
  )

  if (!cluster.state) {
    return (
      <Text dimColor>
        No {ClusterFiles.StateFilename} found in {cluster.path ?? "(unknown)"} —
        has the cluster been bootstrapped yet?
      </Text>
    )
  }

  return (
    <Box flexDirection="column">
      <Text bold color={isFocused ? "cyan" : undefined}>
        {sources.length} process(es)
        {isCompact ? ` (showing ${sliceStart + 1}–${sliceEnd})` : ""} — ↑/↓ or
        j/k select, Enter view log{isFocused ? "" : "  (Tab to focus)"}
      </Text>
      {visibleSources.map((s, i) => {
        const sourceIdx = sliceStart + i,
          liveness = processes[s.label],
          kind = classify(liveness),
          cursorMarker = sourceIdx === cursor ? "›" : " ",
          selected = viewer.path === logPathForSource(s),
          glyph = match(kind)
            .with("alive", () => StatusGlyph.Alive)
            .with("dead", () => StatusGlyph.Dead)
            .otherwise(() => StatusGlyph.Unknown),
          color = match(kind)
            .with("alive", () => "green")
            .with("dead", () => "red")
            .otherwise(() => "gray")
        return (
          <Text key={s.label} inverse={selected}>
            {cursorMarker} <Text color={color}>{glyph}</Text> [{s.kind}]{" "}
            {identifierForSource(s)}
            {endpointForSource(s)} (pid {liveness?.pid ?? "-"})
          </Text>
        )
      })}
    </Box>
  )
}

/** Main panel — unified list of all pid-backed cluster processes. */
export function ProcessMonitorPanel(props: PanelComponentProps) {
  return <ProcessMonitorBody {...props} />
}
ProcessMonitorPanel.id = "process-monitor:panel" as const
ProcessMonitorPanel.title = "Process Monitor" as const

export namespace ProcessMonitorPanel {
  /**
   * Source rows shown when a log is open. Plus the 1-line header gives the
   * panel a 5-line ceiling per the user's compact-mode spec.
   */
  export const CompactRowCount = 4
}
