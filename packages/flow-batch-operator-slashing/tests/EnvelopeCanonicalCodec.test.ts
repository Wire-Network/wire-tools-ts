import { ethers } from "ethers"
import { AttestationType, Envelope } from "@wireio/opp-typescript-models"
import {
  bytesToHex,
  deriveSemanticHeader,
  encodeTaggedEnvelope,
  parseChainTip,
  type TaggedEnvelopeInput
} from "@wireio/test-flow-batch-operator-slashing/EnvelopeCanonicalCodec.js"

/** keccak-timestamp shared by every pinned vector (matches `GOLDEN_TS_MS` in the C++ suite). */
const GOLDEN_TS_MS = 1_775_612_516_983n
/** `ATTESTATION_TYPE_OPERATOR_ACTION` — the type the C++ golden vectors carry. */
const OPERATOR_ACTION = AttestationType.OPERATOR_ACTION
const DEAD = Uint8Array.from([0xde, 0xad, 0xbe, 0xef])
const CAFE = Uint8Array.from([0xca, 0xfe, 0xba, 0xbe, 0x01])

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex")
const fromHex = (h: string): Uint8Array =>
  ethers.getBytes(h.startsWith("0x") ? h : `0x${h}`)
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)
/** Big-endian sequence number in a message id's first 8 bytes. */
const sequenceOf = (messageId: Uint8Array): bigint =>
  ethers.toBigInt(messageId.slice(0, 8))
/** A 32-byte message tip whose first 8 bytes carry `sequence` (the rest zero). */
const tipWithSequence = (sequence: bigint): Uint8Array => {
  const out = new Uint8Array(32)
  out.set(ethers.getBytes(ethers.toBeHex(sequence, 8)), 0)
  return out
}

describe("EnvelopeCanonicalCodec", () => {
  // The keccak digests below are lifted from the C++ oracle's pinned golden vectors in
  // contracts/tests/sysio.msgch_chain_tests.cpp (canonical_oracle_matches_solidity_golden_vectors).
  // Reproducing them proves the TS canonical codec agrees byte-for-byte with the depot's
  // opp_canonical_codec.hpp — the same values the Solidity/Rust emitters must independently produce.
  describe("deriveSemanticHeader — cross-language golden vectors", () => {
    it("reproduces vector A: stream genesis, one attestation, sequence 1", () => {
      const header = deriveSemanticHeader({
        version: 1,
        attestations: [{ type: OPERATOR_ACTION, data: DEAD }],
        timestampMs: GOLDEN_TS_MS,
        previousMessageId: new Uint8Array(0)
      })
      expect(header.payloadSize).toBe(15)
      expect(hex(header.payloadChecksum)).toBe(
        "6429fe11b290953c3e28e6ed7887059307329591c6296d6e41d27e4e6ddcae99"
      )
      expect(hex(header.headerChecksum)).toBe(
        "fb2b80f90bf26934210103982d1ae1f083b047bde00e77e4a337f3b31c8d223c"
      )
      expect(hex(header.messageId)).toBe(
        "0000000000000001210103982d1ae1f083b047bde00e77e4a337f3b31c8d223c"
      )
    })

    it("reproduces vector B: chained from A, two attestations, sequence 2", () => {
      const aMessageId = fromHex(
        "0000000000000001210103982d1ae1f083b047bde00e77e4a337f3b31c8d223c"
      )
      const header = deriveSemanticHeader({
        version: 1,
        attestations: [
          { type: OPERATOR_ACTION, data: DEAD },
          { type: OPERATOR_ACTION, data: CAFE }
        ],
        timestampMs: GOLDEN_TS_MS,
        previousMessageId: aMessageId
      })
      expect(header.payloadSize).toBe(29)
      expect(hex(header.payloadChecksum)).toBe(
        "fdbcffc45ad50a6a2d1376af8c498d86910751868ae7e14fe909477b319ec98d"
      )
      expect(hex(header.headerChecksum)).toBe(
        "8d135355c556a6ed2437e72cf67a093c4c5753cbb3ce71b76c890da8f9965c35"
      )
      expect(hex(header.messageId)).toBe(
        "00000000000000022437e72cf67a093c4c5753cbb3ce71b76c890da8f9965c35"
      )
    })
  })

  describe("deriveSemanticHeader — message-chain sequencing", () => {
    const oneAttestation = [
      { type: AttestationType.UNSPECIFIED, data: utf8("payload") }
    ]

    it("derives sequence 1 at stream genesis (empty tip)", () => {
      const header = deriveSemanticHeader({
        version: 0,
        attestations: oneAttestation,
        timestampMs: GOLDEN_TS_MS,
        previousMessageId: new Uint8Array(0)
      })
      expect(sequenceOf(header.messageId)).toBe(1n)
    })

    it("increments the inbound tip's sequence for a non-genesis message", () => {
      const header = deriveSemanticHeader({
        version: 0,
        attestations: oneAttestation,
        timestampMs: GOLDEN_TS_MS,
        previousMessageId: tipWithSequence(5n)
      })
      expect(sequenceOf(header.messageId)).toBe(6n)
    })

    it("splices only the sequence prefix — message_id shares the header_checksum tail", () => {
      const header = deriveSemanticHeader({
        version: 0,
        attestations: oneAttestation,
        timestampMs: GOLDEN_TS_MS,
        previousMessageId: tipWithSequence(41n)
      })
      expect(hex(header.messageId.slice(8))).toBe(
        hex(header.headerChecksum.slice(8))
      )
      expect(sequenceOf(header.messageId)).toBe(42n)
    })
  })

  describe("encodeTaggedEnvelope — chains BOTH streams (SEC-102)", () => {
    const baseInput: TaggedEnvelopeInput = {
      epochIndex: 7,
      epochEnvelopeIndex: 1,
      epochTimestampMs: GOLDEN_TS_MS,
      payloadVersion: 0,
      tag: "canonical",
      previousMessageId: new Uint8Array(0),
      previousEnvelopeHash: new Uint8Array(0)
    }
    const encode = (over: Partial<TaggedEnvelopeInput>): Envelope =>
      Envelope.fromBinary(encodeTaggedEnvelope({ ...baseInput, ...over }))

    it("carries previous_envelope_hash from the inbound envelope tip", () => {
      // Regression guard for the [P1] fix: the envelope chain was previously left empty, so
      // apply_consensus dropped the envelope before header validation once bootstrap set a tip.
      const previousEnvelopeHash = fromHex("11".repeat(32))
      const previousMessageId = tipWithSequence(4n)
      const env = encode({ previousEnvelopeHash, previousMessageId })
      expect(hex(env.previousEnvelopeHash)).toBe(hex(previousEnvelopeHash))
      expect(hex(env.messages[0].header.previousMessageId)).toBe(
        hex(previousMessageId)
      )
    })

    it("embeds the derived semantic header for its tag + tips", () => {
      const previousMessageId = tipWithSequence(4n)
      const env = encode({ previousMessageId })
      const derived = deriveSemanticHeader({
        version: 0,
        attestations: [
          { type: AttestationType.UNSPECIFIED, data: utf8("canonical") }
        ],
        timestampMs: GOLDEN_TS_MS,
        previousMessageId
      })
      const header = env.messages[0].header
      expect(header.payloadSize).toBe(derived.payloadSize)
      expect(hex(header.payloadChecksum)).toBe(hex(derived.payloadChecksum))
      expect(hex(header.headerChecksum)).toBe(hex(derived.headerChecksum))
      expect(hex(header.messageId)).toBe(hex(derived.messageId))
      expect(sequenceOf(header.messageId)).toBe(5n)
      expect(env.epochIndex).toBe(7)
      expect(env.epochEnvelopeIndex).toBe(1)
    })

    it("leaves both prev fields empty and derives sequence 1 at genesis", () => {
      const env = encode({})
      expect(env.previousEnvelopeHash.length).toBe(0)
      expect(env.messages[0].header.previousMessageId.length).toBe(0)
      expect(sequenceOf(env.messages[0].header.messageId)).toBe(1n)
    })

    it("distinct tags produce distinct message ids (the 3-way dispute split)", () => {
      const previousMessageId = tipWithSequence(4n)
      const previousEnvelopeHash = fromHex("22".repeat(32))
      const ids = ["canonical", "fork-1", "fork-2"].map(tag =>
        hex(
          encode({ tag, previousMessageId, previousEnvelopeHash }).messages[0]
            .header.messageId
        )
      )
      expect(new Set(ids).size).toBe(3)
    })
  })

  describe("parseChainTip", () => {
    it("returns empty at genesis (absent / empty / all-zero, prefixed or not)", () => {
      expect(parseChainTip(undefined).length).toBe(0)
      expect(parseChainTip("").length).toBe(0)
      expect(parseChainTip("0".repeat(64)).length).toBe(0)
      expect(parseChainTip(`0x${"0".repeat(64)}`).length).toBe(0)
    })

    it("decodes a 32-byte tip, tolerating an optional 0x prefix", () => {
      const raw =
        "fb2b80f90bf26934210103982d1ae1f083b047bde00e77e4a337f3b31c8d223c"
      expect(parseChainTip(raw).length).toBe(32)
      expect(hex(parseChainTip(raw))).toBe(raw)
      expect(hex(parseChainTip(`0x${raw}`))).toBe(raw)
    })
  })

  describe("bytesToHex", () => {
    it("lowercase-hex-encodes bytes for the deliver data field", () => {
      expect(bytesToHex(Uint8Array.from([0x00, 0x0a, 0xff]))).toBe("000aff")
    })
  })
})
