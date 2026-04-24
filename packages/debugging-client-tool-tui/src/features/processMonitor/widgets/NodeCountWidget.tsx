import React from "react"
import { Text } from "ink"
import type { StatusBarComponentProps } from "../../../components/StatusBarComponent.js"
import { useAppSelector } from "../../../store/Store.js"
import { selectCluster } from "../../../store/cluster/ClusterSelectors.js"
import { selectAliveCount } from "../../../store/processMonitor/ProcessMonitorSelectors.js"

function NodeCountBody(_: StatusBarComponentProps): React.ReactElement {
  const cluster = useAppSelector(selectCluster),
    alive = useAppSelector(selectAliveCount)
  if (!cluster.state) return <Text dimColor>nodes: ?</Text>
  const total =
    cluster.state.nodes.length +
    cluster.state.batchOperatorNodes.length +
    cluster.state.underwriterNodes.length
  return (
    <Text>
      nodes:{" "}
      <Text bold>
        {alive}/{total}
      </Text>
    </Text>
  )
}

/** Status-bar badge: alive / total node count. */
export function NodeCountWidget(props: StatusBarComponentProps) {
  return <NodeCountBody {...props} />
}
NodeCountWidget.id = "process-monitor:node-count" as const
