import React from "react"
import { Box, Text } from "ink"
import { isString } from "@wireio/shared"
import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import type { PanelComponentProps } from "../../../components/PanelComponent.js"
import { useAppSelector } from "../../../store/Store.js"
import { selectCluster } from "../../../store/cluster/ClusterSelectors.js"
import {
  selectCurrentEpochIndex,
  selectLatestEpoch
} from "../../../store/opp/OPPSelectors.js"

/** Column width for the slot-name column — keeps the grid visually consistent. */
const SlotColumnWidth = 32

/**
 * Endpoint-type names sans UNKNOWN and sans numeric reverse-map entries.
 * Drives the row list — one row per exchange slot.
 */
const EndpointTypeNames = Object.keys(DebugOutpostEndpointsType)
  .filter(isString)
  .filter(v => !/^\d+$/.test(v))
  .filter(
    v => v !== DebugOutpostEndpointsType[DebugOutpostEndpointsType.UNKNOWN]
  )

/** Tally envelopes by endpoint name for the latest cached epoch. */
function computeCounts(
  latest: ReturnType<typeof selectLatestEpoch>
): Map<string, number> {
  return (latest?.envelopes ?? []).reduce<Map<string, number>>((acc, e) => {
    const key = DebugOutpostEndpointsType[e.endpointsType] as string
    acc.set(key, (acc.get(key) ?? 0) + 1)
    return acc
  }, new Map())
}

function EpochTrackerBody(_: PanelComponentProps): React.ReactElement {
  const cluster = useAppSelector(selectCluster),
    currentEpoch = useAppSelector(selectCurrentEpochIndex),
    latest = useAppSelector(selectLatestEpoch),
    epochDurationSec = cluster.config?.epochDurationSec ?? 0,
    counts = computeCounts(latest)
  return (
    <Box flexDirection="column">
      <Text bold>
        Epoch duration: <Text color="cyan">{epochDurationSec}s</Text>
        {"  "}Current epoch: <Text>{currentEpoch || "—"}</Text>
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {EndpointTypeNames.map(slot => (
          <Box key={slot}>
            <Box width={SlotColumnWidth}>
              <Text>{slot}</Text>
            </Box>
            <Text dimColor={(counts.get(slot) ?? 0) === 0}>
              envelopes: {counts.get(slot) ?? 0}
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  )
}

/** Panel — one row per envelope-exchange slot, counts sourced from OPP slice. */
export function EpochTrackerPanel(props: PanelComponentProps) {
  return <EpochTrackerBody {...props} />
}
EpochTrackerPanel.id = "opp:epoch-tracker" as const
EpochTrackerPanel.title = "OPP — Epoch Tracker" as const
