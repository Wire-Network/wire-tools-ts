import React, { useState } from "react"
import { Box, Text, useFocus, useInput } from "ink"
import { match } from "ts-pattern"
import { ClusterFiles } from "@wire-e2e-tests/debugging-shared"
import type { PanelComponentProps } from "../../../components/PanelComponent.js"
import { useService } from "../../../services/ServiceContext.js"
import { ServiceId } from "../../../services/ServiceId.js"
import {
  useAppDispatch,
  useAppSelector
} from "../../../store/Store.js"
import { selectCluster } from "../../../store/cluster/ClusterSelectors.js"
import {
  selectLogViewer,
  selectProcessMap
} from "../../../store/processMonitor/ProcessMonitorSelectors.js"
import { setLogViewerPath } from "../../../store/processMonitor/ProcessMonitorSlice.js"
import {
  PidSourceKind,
  logPathForSource,
  type PidSource
} from "../util/PidSources.js"
import { currentDateStamp } from "../util/dateStamp.js"
import type { ProcessMonitorService } from "../ProcessMonitorService.js"

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
    // Focus by default so arrow-keys and Enter work the moment the route mounts
    // without the user needing to Tab into the panel first.
    { isFocused } = useFocus({ autoFocus: true, id: ProcessMonitorPanel.id }),
    [cursor, setCursor] = useState(0),
    sources: PidSource[] = monitor.listSources()

  useInput(
    (input, key) => {
      if (sources.length === 0) return
      match({ input, key })
        .with({ input: "j" }, () =>
          setCursor(i => Math.min(sources.length - 1, i + 1))
        )
        .with({ key: { downArrow: true } }, () =>
          setCursor(i => Math.min(sources.length - 1, i + 1))
        )
        .with({ input: "k" }, () => setCursor(i => Math.max(0, i - 1)))
        .with({ key: { upArrow: true } }, () =>
          setCursor(i => Math.max(0, i - 1))
        )
        .with({ input: "\r" }, () =>
          dispatch(
            setLogViewerPath(
              logPathForSource(sources[cursor], currentDateStamp())
            )
          )
        )
        .with({ key: { return: true } }, () =>
          dispatch(
            setLogViewerPath(
              logPathForSource(sources[cursor], currentDateStamp())
            )
          )
        )
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
        {sources.length} process(es) — ↑/↓ or j/k select, Enter view log
        {isFocused ? "" : "  (Tab to focus)"}
      </Text>
      {sources.map((s, i) => {
        const liveness = processes[s.label],
          kind = classify(liveness),
          cursorMarker = i === cursor ? "›" : " ",
          selected =
            viewer.path === logPathForSource(s, currentDateStamp()),
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
