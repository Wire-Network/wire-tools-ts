import { PublicKey } from "@solana/web3.js"
import {
  ChainKind,
  DesyndicateLiq,
  LiqYield,
  SyndicateLiq
} from "@wireio/opp-typescript-models"
import {
  encodeDesyndicateLiq,
  encodeLiqYield,
  encodeSyndicateLiq
} from "@wireio/cluster-tool/tools/solana"

/**
 * The three `simple_swap` attestation messages are defined in
 * `wire-sysio/libraries/opp/proto/sysio/opp/attestations/attestations.proto`;
 * these encoders build the GENERATED message values and hand them to the
 * generated serializer, so the round-trip through `fromBinary` is the contract
 * under test (no shape is re-declared anywhere in the harness).
 */
describe("SolanaSyndicationTool encoders", () => {
  /** ASCII "SOLANA"-ish fixed chain code — the encoders are value-agnostic. */
  const chainCode = 0x534f4c414e41n,
    user = PublicKey.unique()

  describe("encodeSyndicateLiq", () => {
    it("round-trips every field through SyndicateLiq.fromBinary", () => {
      const amount = 1_500_000_000n,
        sequence = 7n,
        decoded = SyndicateLiq.fromBinary(
          encodeSyndicateLiq(chainCode, user, amount, sequence)
        )
      expect(decoded.chainCode).toBe(chainCode)
      expect(decoded.amount).toBe(amount)
      expect(decoded.sequence).toBe(sequence)
      expect(decoded.user.kind).toBe(ChainKind.SVM)
      expect([...decoded.user.address]).toEqual([...user.toBytes()])
    })

    it("changes bytes when only the sequence changes (dedupe key is on the wire)", () => {
      const first = encodeSyndicateLiq(chainCode, user, 1n, 1n),
        second = encodeSyndicateLiq(chainCode, user, 1n, 2n)
      expect(Buffer.from(first).equals(Buffer.from(second))).toBe(false)
    })
  })

  describe("encodeLiqYield", () => {
    it("round-trips every field through LiqYield.fromBinary", () => {
      const amount = 42_000n,
        sequence = 8n,
        epoch = 931n,
        decoded = LiqYield.fromBinary(
          encodeLiqYield(chainCode, amount, sequence, epoch)
        )
      expect(decoded.chainCode).toBe(chainCode)
      expect(decoded.amount).toBe(amount)
      expect(decoded.sequence).toBe(sequence)
      expect(decoded.epoch).toBe(epoch)
    })

    it("carries NO user address (the report is global to the outpost)", () => {
      const decoded = LiqYield.fromBinary(
        encodeLiqYield(chainCode, 1n, 1n, 0n)
      )
      expect(Object.keys(decoded)).not.toContain("user")
    })
  })

  describe("encodeDesyndicateLiq", () => {
    it("round-trips every field through DesyndicateLiq.fromBinary", () => {
      const amount = 250n,
        requestId = 99n,
        decoded = DesyndicateLiq.fromBinary(
          encodeDesyndicateLiq(chainCode, user, amount, requestId)
        )
      expect(decoded.chainCode).toBe(chainCode)
      expect(decoded.amount).toBe(amount)
      expect(decoded.requestId).toBe(requestId)
      expect(decoded.user.kind).toBe(ChainKind.SVM)
      expect([...decoded.user.address]).toEqual([...user.toBytes()])
    })

    it("is NOT interchangeable with a SyndicateLiq of the same values", () => {
      const desyndicate = encodeDesyndicateLiq(chainCode, user, 5n, 3n),
        syndicate = encodeSyndicateLiq(chainCode, user, 5n, 3n)
      // Field 4 differs in name only (request_id vs sequence) so the BYTES
      // coincide — the type tag in the envelope entry, not the payload, is what
      // distinguishes the two directions. Pin that so a future field reorder
      // that breaks the assumption is caught here.
      expect(Buffer.from(desyndicate).equals(Buffer.from(syndicate))).toBe(true)
    })
  })
})
