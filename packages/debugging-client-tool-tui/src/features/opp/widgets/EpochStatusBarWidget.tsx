import React from "react"
import { Text } from "ink"
import type { StatusBarComponentProps } from "../../../components/StatusBarComponent.js"
import { useAppSelector } from "../../../store/Store.js"
import { selectCurrentEpochIndex } from "../../../store/opp/OPPSelectors.js"

function EpochStatusBody(_: StatusBarComponentProps): React.ReactElement {
  const epoch = useAppSelector(selectCurrentEpochIndex)
  return (
    <Text>
      epoch: <Text bold>{epoch || "—"}</Text>
    </Text>
  )
}

/** Status-bar badge — current epoch index. */
export function EpochStatusBarWidget(props: StatusBarComponentProps) {
  return <EpochStatusBody {...props} />
}
EpochStatusBarWidget.id = "opp:epoch-status-bar-widget" as const
