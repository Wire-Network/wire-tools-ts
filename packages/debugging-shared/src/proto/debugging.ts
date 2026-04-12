import { asOption } from "@3fv/prelude-ts"
import { isString } from "lodash"

// Re-export generated types from @wireio/opp-typescript-models.
// The debugging protos (sysio/opp/debugging/) are compiled into the
// same package as the rest of the OPP types.
export {
   DebugEnvelopeDataRecord,
   DebugEnvelopeMetadataRecord,
   DebugOutpostEndpointsType,
   PutEnvelopeRequest,
   PutEnvelopeResponse,
   ListEnvelopesRequest,
   ListEnvelopesResponse,
   EnvelopeListEntry,
   GetEnvelopeRequest,
   GetEnvelopeResponse
} from "@wireio/opp-typescript-models"

import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"

/**
 * Derive the endpoints key string used in storage filenames.
 * Uses the enum's own reverse mapping — no manual string table to maintain.
 */
export function endpointsTypeToKey(type: DebugOutpostEndpointsType): string | null {
   return asOption(DebugOutpostEndpointsType[type])
      .filter(isString)
      .getOrNull()
}

/**
 * Generate a lexicographically sortable storage key from epoch index,
 * endpoints key string, and data checksum.
 */
export function generateStorageKey(
   epochIndex: number,
   endpointsKey: string,
   checksum: string
): string {
   const paddedEpoch = String(epochIndex).padStart(8, "0")
   return `${paddedEpoch}-${endpointsKey}-${checksum}`
}
