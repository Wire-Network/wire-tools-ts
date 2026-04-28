import React from "react"
import { Text } from "ink"
import type { StatusBarComponentProps } from "../../../components/StatusBarComponent.js"
import { useAppSelector } from "../../../store/Store.js"
import { selectCluster } from "../../../store/cluster/ClusterSelectors.js"
import {
  selectAliveCount,
  selectTotalCount
} from "../../../store/process-monitor/ProcessMonitorSelectors.js"

function NodeCountBody(_: StatusBarComponentProps): React.ReactElement {
  const cluster = useAppSelector(selectCluster),
    alive = useAppSelector(selectAliveCount),
    total = useAppSelector(selectTotalCount)
  if (!cluster.state) return <Text dimColor>nodes: ?</Text>
  return (
    <Text>
      nodes:{" "}
      <Text bold>
        {alive}/{total}
      </Text>
    </Text>
  )
}

/**
 * Status-bar badge: `alive / total` across every pid-source the process
 * monitor tracks (WIRE nodes + anvil + solana-test-validator). Sourcing
 * `total` from the liveness map keeps the denominator in sync with the
 * process list rendered by `ProcessMonitorPanel` — bumping
 * {@link PidSources.collectPidSources} or `ProcessMonitorService.poll`
 * coverage updates this widget for free.
 */
export function NodeCountWidget(props: StatusBarComponentProps) {
  return <NodeCountBody {...props} />
}
NodeCountWidget.id = "process-monitor:node-count" as const
