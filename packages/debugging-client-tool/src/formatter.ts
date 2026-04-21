import { endpointsTypeToKey } from "@wire-e2e-tests/debugging-shared"
import {
  PutEnvelopeResponse,
  ListEnvelopesResponse,
  DebugOutpostEndpointsType,
  DebugEnvelopeMetadataRecord,
  EnvelopeListEntry,
  GetEnvelopeResponse,
  Envelope,
  Endpoints
} from "@wireio/opp-typescript-models"

/** Output format — plain (tabular) or json */
export enum OutputFormat {
  plain = "plain",
  json = "json"
}

/** Format a list of envelope entries */
export function formatList(
  entries: EnvelopeListEntry[],
  format: OutputFormat
): string {
  if (format === OutputFormat.json) {
    return JSON.stringify(entries.map(entryToPlainObject), null, 2)
  }

  if (entries.length === 0) {
    return "No envelopes found."
  }

  const header = [
    padRight("EPOCH", 8),
    padRight("ENDPOINTS", 28),
    padRight("CHECKSUM", 18),
    padRight("OPERATORS", 30),
    padRight("SIZE", 8),
    padRight("TIMESTAMP", 24)
  ].join("  ")

  const separator = "-".repeat(header.length)

  const rows = entries.map(e =>
    [
      padRight(String(e.epochIndex), 8),
      padRight(endpointsTypeToKey(e.endpointsType) ?? "UNKNOWN", 28),
      padRight(e.checksum, 18),
      padRight(e.batchOpNames.join(", "), 30),
      padRight(String(e.dataSize), 8),
      padRight(formatTimestamp(Number(e.timestamp)), 24)
    ].join("  ")
  )

  return [header, separator, ...rows].join("\n")
}

/** Format a single envelope detail view */
export function formatInspect(
  resp: GetEnvelopeResponse,
  format: OutputFormat
): string {
  if (format === OutputFormat.json) {
    const obj = inspectToPlainObject(resp)
    return JSON.stringify(obj, null, 2)
  }

  const lines: string[] = [
    `Key:           ${resp.key}`,
    `Epoch:         ${resp.epochIndex}`,
    `Endpoints:     ${endpointsTypeToKey(resp.endpointsType) ?? "UNKNOWN"}`,
    `Checksum:      ${resp.checksum}`,
    `Operators:     ${resp.batchOpNames.join(", ")}`,
    `Data Size:     ${resp.dataSize} bytes`,
    `Timestamp:     ${formatTimestamp(Number(resp.timestamp))}`
  ]

  // Decode the envelope data to show message details
  if (resp.envelopeData && resp.envelopeData.length > 0) {
    try {
      const envelope = Envelope.fromBinary(resp.envelopeData)
      lines.push("")
      lines.push("--- Envelope Contents ---")
      lines.push(`  Epoch Index:     ${envelope.epochIndex}`)
      lines.push(
        `  Epoch Timestamp: ${formatTimestamp(Number(envelope.epochTimestamp))}`
      )
      lines.push(`  Envelope Hash:   ${bufToHex(envelope.envelopeHash)}`)
      lines.push(
        `  Previous Hash:   ${bufToHex(envelope.previousEnvelopeHash)}`
      )
      lines.push(`  Merkle:          ${bufToHex(envelope.merkle)}`)
      lines.push(`  Start Msg ID:    ${bufToHex(envelope.startMessageId)}`)
      lines.push(`  End Msg ID:      ${bufToHex(envelope.endMessageId)}`)
      lines.push(`  Messages:        ${envelope.messages.length}`)

      for (let i = 0; i < envelope.messages.length; i++) {
        const msg = envelope.messages[i]
        const payload = msg.payload
        lines.push("")
        lines.push(`  Message[${i}]`)
        if (msg.header) {
          lines.push(`    Message ID:    ${bufToHex(msg.header.messageId)}`)
          lines.push(
            `    Prev Msg ID:   ${bufToHex(msg.header.previousMessageId)}`
          )
          lines.push(
            `    Timestamp:     ${formatTimestamp(Number(msg.header.timestamp))}`
          )
        }
        if (payload) {
          lines.push(`    Version:       ${payload.version}`)
          lines.push(`    Attestations:  ${payload.attestations.length}`)
          for (let a = 0; a < payload.attestations.length; a++) {
            const att = payload.attestations[a]
            lines.push(
              `      [${a}] type=${att.type} data_size=${att.dataSize}`
            )
          }
        }
      }
    } catch (err: any) {
      lines.push("")
      lines.push(`--- Envelope decode failed: ${err.message} ---`)
    }
  }

  return lines.join("\n")
}

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function entryToPlainObject(e: EnvelopeListEntry): Record<string, unknown> {
  return {
    key: e.key,
    epochIndex: e.epochIndex,
    endpointsType: endpointsTypeToKey(e.endpointsType) ?? "UNKNOWN",
    checksum: e.checksum,
    batchOpNames: e.batchOpNames,
    dataSize: e.dataSize,
    timestamp: Number(e.timestamp),
    timestampIso: formatTimestamp(Number(e.timestamp))
  }
}

function inspectToPlainObject(
  resp: GetEnvelopeResponse
): Record<string, unknown> {
  const obj: Record<string, unknown> = {
    key: resp.key,
    epochIndex: resp.epochIndex,
    endpointsType: endpointsTypeToKey(resp.endpointsType) ?? "UNKNOWN",
    checksum: resp.checksum,
    batchOpNames: resp.batchOpNames,
    dataSize: resp.dataSize,
    timestamp: Number(resp.timestamp),
    timestampIso: formatTimestamp(Number(resp.timestamp))
  }

  if (resp.envelopeData && resp.envelopeData.length > 0) {
    try {
      const envelope = Envelope.fromBinary(resp.envelopeData)
      obj.envelope = {
        epochIndex: envelope.epochIndex,
        epochTimestamp: Number(envelope.epochTimestamp),
        envelopeHash: bufToHex(envelope.envelopeHash),
        previousEnvelopeHash: bufToHex(envelope.previousEnvelopeHash),
        merkle: bufToHex(envelope.merkle),
        messageCount: envelope.messages.length,
        messages: envelope.messages.map((msg, i) => ({
          index: i,
          messageId: msg.header ? bufToHex(msg.header.messageId) : null,
          previousMessageId: msg.header
            ? bufToHex(msg.header.previousMessageId)
            : null,
          timestamp: msg.header ? Number(msg.header.timestamp) : null,
          version: msg.payload?.version ?? null,
          attestationCount: msg.payload?.attestations.length ?? 0,
          attestations: (msg.payload?.attestations ?? []).map(a => ({
            type: a.type,
            dataSize: a.dataSize
          }))
        }))
      }
    } catch (err: any) {
      obj.envelopeDecodeError = err.message
    }
  }

  return obj
}

function formatTimestamp(ms: number): string {
  if (ms <= 0) return "-"
  return new Date(ms).toISOString()
}

function bufToHex(buf: Uint8Array | undefined): string {
  if (!buf || buf.length === 0) return "(empty)"
  return (
    Buffer.from(buf).toString("hex").substring(0, 32) +
    (buf.length > 16 ? "..." : "")
  )
}

function padRight(s: string, width: number): string {
  return s.length >= width
    ? s.substring(0, width)
    : s + " ".repeat(width - s.length)
}
