import React from "react"
import { Box, Text } from "ink"

import {
  ClusterFiles,
  NodeRole,
  type NodeState
} from "@wire-e2e-tests/debugging-shared"

import { Panel } from "../components/Panel.js"
import { StatusWidget } from "../components/StatusWidget.js"
import type { ComponentProviders } from "../providers/ComponentProviders.js"
import { FeatureDebugger } from "./FeatureDebugger.js"
import { selectCluster, useAppSelector } from "../store.js"

// ---------------------------------------------------------------------------
//  Panel body
// ---------------------------------------------------------------------------

/**
 * Main `ProcessMonitor` panel — lists every cluster node with its pid-file
 * derived process state. For now the "state" column is a stub; pid-file
 * discovery lands once the harness writes them.
 */
function ProcessMonitorBody(): React.ReactElement {
  const cluster = useAppSelector(selectCluster)

  if (!cluster.state) {
    return (
      <Text dimColor>
        No {ClusterFiles.StateFilename} found in {cluster.path ?? "(unknown)"} —
        has the cluster been bootstrapped yet?
      </Text>
    )
  }

  const rows: NodeState[] = [
    ...cluster.state.nodes,
    ...cluster.state.batchOperatorNodes,
    ...cluster.state.underwriterNodes
  ]

  return (
    <Box flexDirection="column">
      <Text bold>
        {rows.length} node(s) registered — pid-file tracking: pending
      </Text>
      {rows.map(n => (
        <Text key={String(n.nodeId)}>
          [{n.role ?? NodeRole.Producer}] {n.producerName ?? n.nodeId} @{" "}
          {n.host}:{n.port}
        </Text>
      ))}
    </Box>
  )
}

/** Main `ProcessMonitor` panel — always visible, even with no feature active. */
class ProcessMonitorPanel extends Panel {
  readonly id = ProcessMonitorPanel.Id
  readonly title = ProcessMonitorPanel.Title
  readonly priority = 100

  render(): React.ReactElement {
    return <ProcessMonitorBody />
  }
}

namespace ProcessMonitorPanel {
  export const Id = "process-monitor:panel" as const
  export const Title = "Process Monitor" as const
}

// ---------------------------------------------------------------------------
//  Status widget
// ---------------------------------------------------------------------------

function NodeCountBody(): React.ReactElement {
  const cluster = useAppSelector(selectCluster)

  if (!cluster.state) {
    return <Text dimColor>nodes: ?</Text>
  }

  const total =
    cluster.state.nodes.length +
    cluster.state.batchOperatorNodes.length +
    cluster.state.underwriterNodes.length

  return (
    <Text>
      nodes: <Text bold>{total}</Text>
    </Text>
  )
}

/** Compact "nodes: N" badge shown in the status bar. */
class NodeCountWidget extends StatusWidget {
  readonly id = NodeCountWidget.Id
  readonly priority = 100

  render(): React.ReactElement {
    return <NodeCountBody />
  }
}

namespace NodeCountWidget {
  export const Id = "process-monitor:node-count" as const
}

// ---------------------------------------------------------------------------
//  Debugger
// ---------------------------------------------------------------------------

/**
 * Core, always-on debugger. Registers the `ProcessMonitor` panel and the
 * `NodeCount` status widget. Remains usable even when no feature debugger
 * is selected.
 */
export class ProcessMonitor extends FeatureDebugger {
  readonly id = ProcessMonitor.Id
  readonly name = ProcessMonitor.Name
  readonly core = true

  register(providers: typeof ComponentProviders): void {
    providers.register(Panel, new ProcessMonitorPanel())
    providers.register(StatusWidget, new NodeCountWidget())
  }
}

export namespace ProcessMonitor {
  export const Id = "process-monitor" as const
  export const Name = "Process Monitor" as const
}
