import React from "react"
import { Box, Text } from "ink"
import {
  AttestationType,
  type AttestationEntry,
  type Envelope
} from "@wireio/opp-typescript-models"
import type { DebugOPPEnvelopeRecord } from "../../../store/opp/OPPTypes.js"
import {
  decodeAttestation,
  jsonSafe,
  type DecodedAttestation
} from "../util/AttestationCodec.js"
import { attestationCountFor } from "../util/EpochSummary.js"

export interface EnvelopeDetailViewProps {
  /** Envelope record sourced from the OPP slice (BigInts already stringified). */
  record: DebugOPPEnvelopeRecord
  /** Endpoint name (e.g. `"DEPOT_OUTPOST_ETHEREUM"`). Drives the heading. */
  endpointName: string
  /**
   * Cursor position scoped to this envelope's attestation list, or null when
   * this envelope is not the selected one. Decided by the parent route so
   * keyboard input drives the active envelope only.
   */
  cursor: number | null
  /** Whether the row at `cursor` is expanded (Enter toggles in the parent). */
  expanded: boolean
}

/**
 * Per-envelope detail block: heading + flat list of attestations. Each
 * attestation row shows its `type` and `dataSize`. Pressing Enter on the
 * cursor row expands the parent's `expanded` flag → we render the entry's
 * decoded data field as pretty-printed JSON below the heading.
 */
export function EnvelopeDetailView(
  props: EnvelopeDetailViewProps
): React.ReactElement {
  const { record, endpointName, cursor, expanded } = props,
    attestations = flattenAttestations(record.envelope),
    count = attestationCountFor(record.envelope)
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="cyan">
        {endpointName}
        {"  "}
        <Text dimColor>
          checksum {record.checksum} · {count} attestation(s)
        </Text>
      </Text>
      {attestations.map((att, i) => {
        const isCursor = cursor === i,
          marker = isCursor
            ? EnvelopeDetailView.CursorMarker
            : EnvelopeDetailView.CursorPlaceholder,
          typeName = attestationTypeName(att.type)
        return (
          <Box key={i} flexDirection="column">
            <Text inverse={isCursor}>
              {marker} #{i} {typeName} · {att.dataSize} bytes
            </Text>
            {isCursor && expanded && (
              <Box
                marginLeft={EnvelopeDetailView.ExpansionIndent}
                flexDirection="column"
              >
                {renderExpansion(att)}
              </Box>
            )}
          </Box>
        )
      })}
    </Box>
  )
}

/** Flatten every message's payload into a single array of attestation entries. */
export function flattenAttestations(
  envelope: Envelope | undefined
): AttestationEntry[] {
  if (!envelope) return []
  return (envelope.messages ?? []).flatMap(
    m => m.payload?.attestations ?? []
  )
}

/** Reverse-map `AttestationType` numeric values to their named label. */
function attestationTypeName(type: AttestationType | number): string {
  const reverse = AttestationType as unknown as Record<number, string>
  return reverse[type] ?? `TYPE_${type}`
}

/**
 * Render the accordion-expanded JSON for one attestation. The renderer
 * dispatches on the entry's `type` via `decodeAttestation`:
 *
 *   - `decoded` — the bytes parsed cleanly with the type-matched
 *     `MessageType`; we display the typed message (e.g. `BatchOperatorGroups`)
 *     as pretty JSON, with a header line giving the protobuf type name.
 *   - `raw` — no decoder registered or decode failed; we fall back to the
 *     raw `AttestationEntry` (header includes the reason).
 *
 * Both paths run through `jsonSafe` so `BigInt` / `Uint8Array` fields don't
 * blow up `JSON.stringify`.
 */
function renderExpansion(att: AttestationEntry): React.ReactNode {
  const decoded: DecodedAttestation = decodeAttestation(att)
  if (decoded.kind === "decoded") {
    const body = JSON.stringify(
      jsonSafe(decoded.value),
      null,
      EnvelopeDetailView.JsonIndent
    )
    return (
      <>
        <Text dimColor>{decoded.typeName}</Text>
        <Text>{body}</Text>
      </>
    )
  }
  const body = JSON.stringify(
    jsonSafe(decoded.entry),
    null,
    EnvelopeDetailView.JsonIndent
  )
  return (
    <>
      <Text color="yellow" dimColor>
        raw entry — {decoded.reason}
      </Text>
      <Text>{body}</Text>
    </>
  )
}

export namespace EnvelopeDetailView {
  /** Marker prefix on the cursor row (when this envelope is the selected one). */
  export const CursorMarker = "›" as const
  /** Same width as `CursorMarker` — keeps non-cursor rows aligned. */
  export const CursorPlaceholder = " " as const
  /** Indent the JSON expansion under the row that triggered it. */
  export const ExpansionIndent = 4
  /** `JSON.stringify` indent for the accordion expansion. */
  export const JsonIndent = 2
}
