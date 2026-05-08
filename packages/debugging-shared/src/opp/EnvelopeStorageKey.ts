import { asOption } from "@3fv/prelude-ts"
import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"

/**
 * Decomposed form of a canonical envelope storage key. Filenames are written
 * by the server as `<epochIndex>-<endpointsKey>-<checksum>.{data,metadata}`.
 */
export interface ParsedEnvelopeStorageKey {
  /** The original, fully-formed key (round-trips back to the filename). */
  key: string
  /** Numeric epoch index extracted from the zero-padded prefix. */
  epochIndex: number
  /** Endpoints enum variant name as stored in the filename. */
  endpointsKey: string
  /** Truncated sha256 checksum suffix. */
  checksum: string
}

/**
 * Parse a storage key of the form `"<epochIndex>-<endpointsKey>-<checksum>"`.
 *
 * @param key Filename-style storage key without its extension.
 * @returns The parsed components, or `null` if the key is malformed.
 *
 * @example parseEnvelopeStorageKey("00000042-OUTPOST_ETHEREUM_DEPOT-abc123def4567890")
 */
export function parseEnvelopeStorageKey(
  key: string
): ParsedEnvelopeStorageKey | null {
  const firstDash = key.indexOf("-")
  if (firstDash < 0) return null
  const lastDash = key.lastIndexOf("-")
  if (lastDash <= firstDash) return null

  const epochStr = key.substring(0, firstDash),
    endpointsKey = key.substring(firstDash + 1, lastDash),
    checksum = key.substring(lastDash + 1),
    epochIndex = parseInt(epochStr, 10)
  if (isNaN(epochIndex)) return null

  return { key, epochIndex, endpointsKey, checksum }
}

/**
 * Reverse-map an endpoints enum name back to its numeric value. Falls back
 * to `UNKNOWN` when no matching member exists — e.g. a peer on an older
 * protobuf schema wrote a name we no longer recognize.
 */
export function resolveEndpointsType(
  endpointsKey: string
): DebugOutpostEndpointsType {
  return asOption(
    (DebugOutpostEndpointsType as Record<string, unknown>)[endpointsKey]
  )
    .filter((v): v is number => typeof v === "number")
    .map(v => v as DebugOutpostEndpointsType)
    .getOrElse(DebugOutpostEndpointsType.UNKNOWN)
}
