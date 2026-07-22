import { asOption } from "@3fv/prelude-ts"
import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"

const CanonicalEpochPattern = /^\d{8}$/
const CanonicalChecksumPattern = /^[0-9a-f]{16}$/

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
 * Serialized issue codes for canonical storage-key validation failures.
 * Changing a value changes the persisted diagnostic contract consumed by strict
 * validation clients and evidence readers.
 */
export enum EnvelopeStorageKeyValidationIssue {
  /** Changing this value changes the diagnostic code for malformed key geometry. */
  Format = "format",
  /** Changing this value changes the diagnostic code for invalid epoch prefixes. */
  Epoch = "epoch",
  /** Changing this value changes the diagnostic code for invalid endpoint names. */
  Endpoints = "endpoints",
  /** Changing this value changes the diagnostic code for invalid checksum suffixes. */
  Checksum = "checksum"
}

/** Typed outcome of validating a canonical envelope storage key. */
export type EnvelopeStorageKeyValidationResult =
  | { readonly kind: "valid"; readonly value: ParsedEnvelopeStorageKey }
  | { readonly kind: "invalid"; readonly issue: EnvelopeStorageKeyValidationIssue }

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
 * Validate the canonical envelope storage-key geometry written by the server.
 * Unlike {@link parseEnvelopeStorageKey}, this rejects non-canonical values
 * and reports the invalid component without throwing.
 *
 * @param key Filename-style storage key without its extension.
 * @returns A parsed canonical key or the issue code for its invalid component.
 *
 * @example validateEnvelopeStorageKey("00000042-OUTPOST_ETHEREUM_DEPOT-abc123def4567890")
 */
export function validateEnvelopeStorageKey(
  key: string
): EnvelopeStorageKeyValidationResult {
  const segments = key.split("-"),
    epochKey = segments.at(0) ?? "",
    endpointsKey = segments.at(1) ?? "",
    checksum = segments.at(2) ?? "",
    endpointsType = resolveEndpointsType(endpointsKey)
  if (segments.length !== 3) {
    return { kind: "invalid", issue: EnvelopeStorageKeyValidationIssue.Format }
  }
  if (!CanonicalEpochPattern.test(epochKey)) {
    return { kind: "invalid", issue: EnvelopeStorageKeyValidationIssue.Epoch }
  }
  if (
    endpointsType === DebugOutpostEndpointsType.UNKNOWN ||
    DebugOutpostEndpointsType[endpointsType] !== endpointsKey
  ) {
    return {
      kind: "invalid",
      issue: EnvelopeStorageKeyValidationIssue.Endpoints
    }
  }
  if (!CanonicalChecksumPattern.test(checksum)) {
    return {
      kind: "invalid",
      issue: EnvelopeStorageKeyValidationIssue.Checksum
    }
  }

  return {
    kind: "valid",
    value: {
      key,
      epochIndex: Number(epochKey),
      endpointsKey,
      checksum
    }
  }
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
