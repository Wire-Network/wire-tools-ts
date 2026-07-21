import { endpointsTypeToKey } from "@wireio/debugging-shared"
import {
  EnvelopeListEntry,
  Envelope,
  GetEnvelopeResponse
} from "@wireio/opp-typescript-models"
import { EnvelopeRenderer } from "./EnvelopeRenderer.js"

/** Output format produced by {@link formatList} and {@link formatInspect}. */
export enum OutputFormat {
  plain = "plain",
  json = "json"
}

/**
 * Fixed-width column sizes for `OutputFormat.plain` list rendering. Change
 * these in tandem — the header and the row builder both read from the same
 * namespace, so widening a column here widens it everywhere.
 */
namespace ColumnWidth {
  export const Epoch = 8
  export const Endpoints = 28
  export const Checksum = 18
  export const Operators = 30
  export const Size = 8
  export const Timestamp = 24
}

/**
 * Display constants for the plain formatter (companion namespace, like
 * {@link ColumnWidth}).
 */
namespace Formatter {
  /** Printed when the endpoints enum resolves to an unknown variant. */
  export const UnknownEndpoints = "UNKNOWN"
  /** Caps the rendered hex width for byte-buffer fields. */
  export const BufHexChars = 32
  /**
   * Source-buffer length (bytes) that trips the `"..."` suffix — compared
   * against the ORIGINAL byte count, not the trimmed hex length, so keep it
   * consistent with `BufHexChars / 2`.
   */
  export const BufHexEllipsisBytes = 16
}

/**
 * Format a list of envelope entries as either a fixed-width table or JSON.
 *
 * @param entries - Envelope list entries returned by `EnvelopeList`.
 * @param format  - Target output format.
 * @returns Newline-joined table (plain) or a pretty-printed JSON array.
 *
 * @example
 * stdout.info(formatList(resp.entries, OutputFormat.plain))
 */
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
    padRight("EPOCH", ColumnWidth.Epoch),
    padRight("ENDPOINTS", ColumnWidth.Endpoints),
    padRight("CHECKSUM", ColumnWidth.Checksum),
    padRight("OPERATORS", ColumnWidth.Operators),
    padRight("SIZE", ColumnWidth.Size),
    padRight("TIMESTAMP", ColumnWidth.Timestamp)
  ].join("  ")

  const separator = "-".repeat(header.length)

  const rows = entries.map(e =>
    [
      padRight(String(e.epochIndex), ColumnWidth.Epoch),
      padRight(
        endpointsTypeToKey(e.endpointsType) ?? Formatter.UnknownEndpoints,
        ColumnWidth.Endpoints
      ),
      padRight(e.checksum, ColumnWidth.Checksum),
      padRight(e.batchOpNames.join(", "), ColumnWidth.Operators),
      padRight(String(e.dataSize), ColumnWidth.Size),
      padRight(formatTimestamp(Number(e.timestamp)), ColumnWidth.Timestamp)
    ].join("  ")
  )

  return [header, separator, ...rows].join("\n")
}

/**
 * Format a single envelope detail view, optionally decoding the embedded
 * protobuf payload.
 *
 * @param resp   - Response body from `EnvelopeGet`.
 * @param format - Target output format.
 * @returns Multi-line string (plain) or pretty-printed JSON object.
 *
 * @example
 * stdout.info(formatInspect(resp, OutputFormat.json))
 */
export function formatInspect(
  resp: GetEnvelopeResponse,
  format: OutputFormat
): string {
  if (format === OutputFormat.json) {
    return JSON.stringify(inspectToPlainObject(resp), null, 2)
  }

  const headerLines = [
    `Key:           ${resp.key}`,
    `Epoch:         ${resp.epochIndex}`,
    `Endpoints:     ${endpointsTypeToKey(resp.endpointsType) ?? Formatter.UnknownEndpoints}`,
    `Checksum:      ${resp.checksum}`,
    `Operators:     ${resp.batchOpNames.join(", ")}`,
    `Data Size:     ${resp.dataSize} bytes`,
    `Timestamp:     ${formatTimestamp(Number(resp.timestamp))}`
  ]

  const envelopeSection = resp.envelopeData?.length
    ? new EnvelopeRenderer(resp.envelopeData).render()
    : null

  return [...headerLines, ...(envelopeSection ? [envelopeSection] : [])].join(
    "\n"
  )
}

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

/** Shape an envelope list entry for JSON output. */
function entryToPlainObject(e: EnvelopeListEntry): Record<string, unknown> {
  return {
    key: e.key,
    epochIndex: e.epochIndex,
    endpointsType: endpointsTypeToKey(e.endpointsType) ?? Formatter.UnknownEndpoints,
    checksum: e.checksum,
    batchOpNames: e.batchOpNames,
    dataSize: e.dataSize,
    timestamp: Number(e.timestamp),
    timestampIso: formatTimestamp(Number(e.timestamp))
  }
}

/** Shape an envelope inspect response for JSON output. */
function inspectToPlainObject(
  resp: GetEnvelopeResponse
): Record<string, unknown> {
  const obj: Record<string, unknown> = {
    key: resp.key,
    epochIndex: resp.epochIndex,
    endpointsType: endpointsTypeToKey(resp.endpointsType) ?? Formatter.UnknownEndpoints,
    checksum: resp.checksum,
    batchOpNames: resp.batchOpNames,
    dataSize: resp.dataSize,
    timestamp: Number(resp.timestamp),
    timestampIso: formatTimestamp(Number(resp.timestamp))
  }

  if (resp.envelopeData?.length) {
    try {
      const envelope = Envelope.fromBinary(resp.envelopeData)
      obj.envelope = {
        epochIndex: envelope.epochIndex,
        epochTimestamp: Number(envelope.epochTimestamp),
        envelopeHash: bufToHex(envelope.envelopeHash),
        previousEnvelopeHash: bufToHex(envelope.previousEnvelopeHash),
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
    } catch (err) {
      obj.envelopeDecodeError = err.message
    }
  }

  return obj
}

/** ISO-8601 timestamp, or `"-"` for missing/zero values. */
export function formatTimestamp(ms: number): string {
  return ms <= 0 ? "-" : new Date(ms).toISOString()
}

/**
 * Truncated hex representation of a byte buffer. Returns `"(empty)"` for
 * missing/zero-length input and appends `"..."` when the source exceeds
 * {@link Formatter.BufHexEllipsisBytes} bytes.
 */
export function bufToHex(buf: Uint8Array | undefined): string {
  if (!buf || buf.length === 0) return "(empty)"
  const hex = Buffer.from(buf).toString("hex").substring(0, Formatter.BufHexChars)
  return buf.length > Formatter.BufHexEllipsisBytes ? `${hex}...` : hex
}

/** Right-pad `s` to `width` columns, truncating if already longer. */
function padRight(s: string, width: number): string {
  return s.length >= width
    ? s.substring(0, width)
    : s + " ".repeat(width - s.length)
}
