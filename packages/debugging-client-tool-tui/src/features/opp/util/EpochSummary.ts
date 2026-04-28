import { isString } from "@wireio/shared"
import {
  DebugOutpostEndpointsType,
  type Envelope
} from "@wireio/opp-typescript-models"
import type {
  DebugOPPEnvelopeRecord,
  DebugOPPEpochRecord
} from "../../../store/opp/OPPTypes.js"

/**
 * Endpoint-type names sans `UNKNOWN` and sans the numeric reverse-map
 * entries that protobuf-ts emits on every numeric enum. Single source of
 * truth for both the EpochTracker column list and the EpochDetail overview.
 */
export const EndpointTypeNames: readonly string[] = Object.keys(
  DebugOutpostEndpointsType
)
  .filter(isString)
  .filter(v => !/^\d+$/.test(v))
  .filter(
    v => v !== DebugOutpostEndpointsType[DebugOutpostEndpointsType.UNKNOWN]
  )

/**
 * Sum of `payload.attestations.length` across every message in `envelope`.
 * Returns 0 for malformed/missing payloads — defensive because the JSON
 * roundtrip in `OPPTrackingService.plainify` could in principle drop a
 * field on an unexpected protobuf version.
 */
export function attestationCountFor(envelope: Envelope): number {
  if (!envelope) return 0
  return (envelope.messages ?? []).reduce(
    (acc, msg) => acc + (msg.payload?.attestations?.length ?? 0),
    0
  )
}

/**
 * Index a single epoch's envelopes by endpoint name (e.g. `"DEPOT_OUTPOST"`).
 * Returns a Map so the panel can read O(1) per cell.
 */
export function indexEnvelopesByEndpoint(
  epoch: DebugOPPEpochRecord
): Map<string, DebugOPPEnvelopeRecord> {
  return epoch.envelopes.reduce<Map<string, DebugOPPEnvelopeRecord>>(
    (acc, env) => {
      const key = DebugOutpostEndpointsType[env.endpointsType] as
        | string
        | undefined
      if (key) acc.set(key, env)
      return acc
    },
    new Map()
  )
}

/**
 * The most-recent `receivedAt` across every envelope in this epoch — what
 * the panel labels `updated_timestamp`. Returns null for an empty epoch.
 */
export function epochUpdatedAt(epoch: DebugOPPEpochRecord): number | null {
  if (epoch.envelopes.length === 0) return null
  return epoch.envelopes.reduce((acc, env) => Math.max(acc, env.receivedAt), 0)
}

/**
 * True when every endpoint type has a corresponding envelope in `epoch`.
 * Used to drive the latest-epoch border color (yellow → green transition).
 */
export function isEpochComplete(
  epoch: DebugOPPEpochRecord,
  endpointTypeNames: readonly string[] = EndpointTypeNames
): boolean {
  const seen = indexEnvelopesByEndpoint(epoch)
  return endpointTypeNames.every(name => seen.has(name))
}

/** Total attestation count across every envelope in an epoch. */
export function totalAttestationsFor(epoch: DebugOPPEpochRecord): number {
  return epoch.envelopes.reduce(
    (acc, env) => acc + attestationCountFor(env.envelope),
    0
  )
}
