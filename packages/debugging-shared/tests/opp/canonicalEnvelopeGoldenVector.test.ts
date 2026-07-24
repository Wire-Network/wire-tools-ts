import { Envelope } from "@wireio/opp-typescript-models"

import { decodeCanonicalMessage } from "@wireio/debugging-shared"

/**
 * Golden vector A from
 * `wire-sysio/contracts/tests/sysio.msgch_chain_tests.cpp`
 * (`canonical_oracle_matches_solidity_golden_vectors`): a depot-shape envelope,
 * epoch 7, stream genesis, one `0xdeadbeef` attestation.
 *
 * These are the FIELD-COMPLETE canonical OPP bytes, asserted byte-equal there
 * against the generated Solidity codec and the Rust side. `sysio.msgch` stores
 * exactly these bytes as `outbound_envelope.raw_envelope`, and the batch
 * operator plugin emits that buffer verbatim as the debug `.data` artifact — so
 * this is precisely the shape the strict reader sees on a real cluster.
 */
const GoldenEnvelopeHex =
  "0a00120e0a04080110011206080210e9f40128f7b483d6d63330073800a20100c20292010a7f0a0c0a04" +
  "0800100012040800100012200000000000000001210103982d1ae1f083b047bde00e77e4a337f3b31c8d" +
  "223c1a00280f32206429fe11b290953c3e28e6ed7887059307329591c6296d6e41d27e4e6ddcae9938f7" +
  "b483d6d6334220fb2b80f90bf26934210103982d1ae1f083b047bde00e77e4a337f3b31c8d223c120f08" +
  "01120b08d10f10041a04deadbeef"

const GoldenEpochIndex = 7

describe("canonical OPP envelope golden vector", () => {
  const bytes = new Uint8Array(Buffer.from(GoldenEnvelopeHex, "hex"))

  it("accepts the field-complete canonical encoding a real depot emits", () => {
    // When: the strict path validates real canonical envelope bytes.
    const envelope = decodeCanonicalMessage(Envelope, bytes)

    // Then: they are accepted and decode to the golden values.
    expect(envelope.epochIndex).toBe(GoldenEpochIndex)
    expect(envelope.messages).toHaveLength(1)
  })

  it("does not require equality with the proto3 default-omitting writer", () => {
    // Given: the canonical form writes every singular field unconditionally,
    // including proto3 defaults — empty `envelope_hash` leads as `0a 00`.
    expect(Buffer.from(bytes.slice(0, 2)).toString("hex")).toBe("0a00")

    // Then: re-encoding through the generated writer drops those defaults, so a
    // round-trip byte-equality check would reject this legitimate envelope.
    // Strict validation must not be defined that way.
    const reencoded = Envelope.toBinary(Envelope.fromBinary(bytes))
    expect(reencoded.length).toBeLessThan(bytes.length)
    expect(Buffer.from(reencoded).equals(Buffer.from(bytes))).toBe(false)
  })
})
