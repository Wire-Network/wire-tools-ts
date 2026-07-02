import { Envelope } from "@wireio/opp-typescript-models"
import { bufToHex, formatTimestamp } from "./formatter.js"

/**
 * Renders the decoded OPP envelope section of the plain inspect view. Follows
 * the `Renderer { render(): string }` shape used across the harness; the raw
 * envelope bytes are injected via the constructor.
 */
export class EnvelopeRenderer {
  constructor(private readonly envelopeData: Uint8Array) {}

  /** The multi-line envelope section, or a decode-failure line on bad bytes. */
  render(): string {
    try {
      const envelope = Envelope.fromBinary(this.envelopeData)
      const head = [
        "",
        "--- Envelope Contents ---",
        `  Epoch Index:     ${envelope.epochIndex}`,
        `  Epoch Timestamp: ${formatTimestamp(Number(envelope.epochTimestamp))}`,
        `  Envelope Hash:   ${bufToHex(envelope.envelopeHash)}`,
        `  Previous Hash:   ${bufToHex(envelope.previousEnvelopeHash)}`,
        `  Messages:        ${envelope.messages.length}`
      ]

      const messageLines = envelope.messages.flatMap((msg, i) => {
        const payload = msg.payload
        const header = msg.header
          ? [
              `    Message ID:    ${bufToHex(msg.header.messageId)}`,
              `    Prev Msg ID:   ${bufToHex(msg.header.previousMessageId)}`,
              `    Timestamp:     ${formatTimestamp(Number(msg.header.timestamp))}`
            ]
          : []
        const payloadLines = payload
          ? [
              `    Version:       ${payload.version}`,
              `    Attestations:  ${payload.attestations.length}`,
              ...payload.attestations.map(
                (att, a) =>
                  `      [${a}] type=${att.type} data_size=${att.dataSize}`
              )
            ]
          : []
        return ["", `  Message[${i}]`, ...header, ...payloadLines]
      })

      return [...head, ...messageLines].join("\n")
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return `\n--- Envelope decode failed: ${message} ---`
    }
  }
}
