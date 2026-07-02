import Fs from "node:fs"
import Path from "node:path"
import {
  AttestationType,
  DebugOutpostEndpointsType
} from "@wireio/opp-typescript-models"
import { EnvelopeRecordFile } from "@wireio/debugging-shared"

/**
 * Scanners over the cluster's `data/opp-debugging/` artifacts — the raw
 * serialized OPP envelope bytes each side of a cross-chain edge emitted or
 * consumed (file naming: `<epoch>-<DIRECTION>-<checksum>.data`).
 *
 * Negative-assertion flows (variance revert, private-reserve gating) use these
 * to prove a `SWAP_REVERT` attestation circulated without pulling the full
 * proto decoder into the scenario: the attestation's type tag has a fixed,
 * unambiguous byte encoding inside the envelope payload.
 */

/**
 * Protobuf varint encoding of a non-negative integer (7-bit groups,
 * continuation MSB) — the wire form of an enum value inside a message.
 *
 * @param value - The non-negative integer to encode.
 * @returns The varint bytes, least-significant group first.
 */
export function varintBytes(value: number): number[] {
  const bytes: number[] = []
  let remaining = value
  while (remaining > 0x7f) {
    bytes.push((remaining & 0x7f) | 0x80)
    remaining >>>= 7
  }
  bytes.push(remaining)
  return bytes
}

/**
 * Protobuf field-1 varint tag (`(1 << 3) | 0` = `0x08`) — the encoding of an
 * `AttestationEntry.type` cell inside a serialized envelope payload.
 */
const AttestationEntryTypeFieldTag = 0x08

/**
 * The serialized byte pattern of an `AttestationEntry.type` cell for `type` —
 * field-1 varint tag + the enum value's varint. Matching this window inside an
 * envelope's `.data` bytes proves an attestation of that type is present
 * (false positives would need the identical window inside another payload —
 * vanishingly unlikely for these multi-byte enum values).
 *
 * @param type - The attestation type to encode.
 * @returns The tagged varint byte pattern.
 */
export function attestationEntryTag(type: AttestationType): Uint8Array {
  return Uint8Array.of(AttestationEntryTypeFieldTag, ...varintBytes(type))
}

/**
 * Whether any `.data` envelope artifact for `direction` contains `needle`.
 *
 * @param oppDebuggingDirectory - The cluster's `data/opp-debugging/` path.
 * @param direction - The cross-chain edge to scan (filename fragment is the
 *   enum member's name).
 * @param needle - The byte pattern to search for (e.g. {@link attestationEntryTag}).
 * @returns Whether the pattern appears in at least one matching artifact.
 */
export function envelopeDataContains(
  oppDebuggingDirectory: string,
  direction: DebugOutpostEndpointsType,
  needle: Uint8Array
): boolean {
  if (!Fs.existsSync(oppDebuggingDirectory)) return false
  const directionFragment = DebugOutpostEndpointsType[direction]
  return Fs.readdirSync(oppDebuggingDirectory)
    .filter(
      name =>
        name.endsWith(EnvelopeRecordFile.DataExt) &&
        name.includes(directionFragment)
    )
    .some(name =>
      Fs.readFileSync(Path.join(oppDebuggingDirectory, name)).includes(
        Buffer.from(needle)
      )
    )
}

/**
 * Whether a `SWAP_REVERT` attestation has circulated on `direction` — the
 * canonical negative-path proof for the variance-revert and private-reserve
 * gating flows.
 *
 * @param oppDebuggingDirectory - The cluster's `data/opp-debugging/` path.
 * @param direction - The cross-chain edge to scan (default: depot → Ethereum).
 * @returns Whether any matching envelope carries a SWAP_REVERT attestation.
 */
export function containsSwapRevert(
  oppDebuggingDirectory: string,
  direction: DebugOutpostEndpointsType = DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM
): boolean {
  return envelopeDataContains(
    oppDebuggingDirectory,
    direction,
    attestationEntryTag(AttestationType.SWAP_REVERT)
  )
}
