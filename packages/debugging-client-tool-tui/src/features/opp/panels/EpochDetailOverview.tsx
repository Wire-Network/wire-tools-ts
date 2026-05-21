import React from "react"
import { Box, Text } from "ink"
import type { DebugOPPEpochRecord } from "../../../store/opp/OPPTypes.js"
import {
  EndpointTypeNames,
  attestationCountFor,
  indexEnvelopesByEndpoint,
  totalAttestationsFor
} from "../util/EpochSummary.js"
import { EpochTrackerPanel } from "./EpochTrackerPanel.js"

export interface EpochDetailOverviewProps {
  /** The selected epoch record, or undefined when not cached / invalid epoch param. */
  record: DebugOPPEpochRecord | undefined
}

/**
 * Static summary of the selected epoch — per-endpoint status (✓ + count or
 * `unreceived` in yellow), total attestation count across every received
 * envelope, and the `checksum` metadata for each present envelope. Lives
 * above the scrollable {@link EnvelopeDetailView} stack.
 */
export function EpochDetailOverview(
  props: EpochDetailOverviewProps
): React.ReactElement {
  const { record } = props
  if (!record) {
    return (
      <Box flexDirection="column">
        <Text dimColor>{EpochDetailOverview.MissingEpochText}</Text>
      </Box>
    )
  }
  const byEndpoint = indexEnvelopesByEndpoint(record),
    total = totalAttestationsFor(record),
    indent = " ".repeat(EpochDetailOverview.MetadataIndent)
  return (
    <Box flexDirection="column">
      <Text bold>
        Epoch <Text color="cyan">{record.epoch}</Text>
        {"  "}total attestations: <Text color="cyan">{total}</Text>
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {EndpointTypeNames.flatMap(name => {
          const env = byEndpoint.get(name),
            paddedName = name.padEnd(EpochDetailOverview.EndpointLabelWidth)
          if (!env) {
            return [
              <Text key={name}>
                {paddedName}
                <Text color={EpochTrackerPanel.PendingColor}>
                  {EpochDetailOverview.UnreceivedLabel}
                </Text>
              </Text>
            ]
          }
          const count = attestationCountFor(env.envelope)
          return [
            <Text key={`${name}-row`}>
              {paddedName}
              <Text color={EpochTrackerPanel.ReceivedColor}>
                {EpochTrackerPanel.ReceivedIcon} {count} attestations
              </Text>
            </Text>,
            <Text key={`${name}-meta`} dimColor>
              {indent}checksum: {env.checksum}
            </Text>
          ]
        })}
      </Box>
    </Box>
  )
}

export namespace EpochDetailOverview {
  /** Width of the endpoint-name column in the overview. */
  export const EndpointLabelWidth = 26
  /** Number of spaces the metadata sub-row is indented under its endpoint. */
  export const MetadataIndent = 2
  /** Inline label for an endpoint we haven't received yet. */
  export const UnreceivedLabel = "unreceived" as const
  /** Empty-state copy when the route param doesn't match any cached epoch. */
  export const MissingEpochText =
    "Epoch not cached. Press Esc to return to the tracker." as const
}
