import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import {
  AttestationType,
  DebugOutpostEndpointsType
} from "@wireio/opp-typescript-models"
import {
  attestationEntryTag,
  containsDesyndicateLiq,
  containsLiqYield,
  containsSwapRevert,
  containsSyndicateLiq,
  envelopeDataContains,
  varintBytes
} from "@wireio/cluster-tool/flow"

/** The known wire encoding of `ATTESTATION_TYPE_SWAP_REVERT` (60955). */
const SwapRevertTagBytes = [0x08, 0x9b, 0xdc, 0x03]
/** The known wire encoding of `ATTESTATION_TYPE_SYNDICATE_LIQ` (60963). */
const SyndicateLiqTagBytes = [0x08, 0xa3, 0xdc, 0x03]
/** The known wire encoding of `ATTESTATION_TYPE_LIQ_YIELD` (60964). */
const LiqYieldTagBytes = [0x08, 0xa4, 0xdc, 0x03]
/** The known wire encoding of `ATTESTATION_TYPE_DESYNDICATE_LIQ` (60965). */
const DesyndicateLiqTagBytes = [0x08, 0xa5, 0xdc, 0x03]

describe("oppEnvelopeScan", () => {
  let oppDirectory: string

  /** Write one `.data` artifact for `direction` carrying `payload`. */
  function writeArtifact(
    direction: DebugOutpostEndpointsType,
    payload: Buffer,
    epoch = 1
  ): void {
    const name = `${String(epoch).padStart(8, "0")}-${DebugOutpostEndpointsType[direction]}-abcdef0123456789.data`
    Fs.writeFileSync(Path.join(oppDirectory, name), payload)
  }

  beforeEach(() => {
    oppDirectory = Fs.mkdtempSync(Path.join(Os.tmpdir(), "opp-scan-test-"))
  })
  afterEach(() => {
    Fs.rmSync(oppDirectory, { recursive: true, force: true })
  })

  describe("varintBytes", () => {
    it("encodes single-group values as themselves", () => {
      expect(varintBytes(0)).toEqual([0])
      expect(varintBytes(0x7f)).toEqual([0x7f])
    })
    it("encodes multi-group values least-significant group first", () => {
      expect(varintBytes(AttestationType.SWAP_REVERT)).toEqual(
        SwapRevertTagBytes.slice(1)
      )
    })
  })

  describe("attestationEntryTag", () => {
    it("prefixes the field-1 varint tag to the enum's varint", () => {
      expect([...attestationEntryTag(AttestationType.SWAP_REVERT)]).toEqual(
        SwapRevertTagBytes
      )
    })
    it("encodes each liq-syndication type distinctly", () => {
      expect([...attestationEntryTag(AttestationType.SYNDICATE_LIQ)]).toEqual(
        SyndicateLiqTagBytes
      )
      expect([...attestationEntryTag(AttestationType.LIQ_YIELD)]).toEqual(
        LiqYieldTagBytes
      )
      expect([...attestationEntryTag(AttestationType.DESYNDICATE_LIQ)]).toEqual(
        DesyndicateLiqTagBytes
      )
    })
  })

  describe("envelopeDataContains / containsSwapRevert", () => {
    it("is false for a missing directory", () => {
      expect(containsSwapRevert(Path.join(oppDirectory, "absent"))).toBe(false)
    })

    it("is false when no artifact carries the pattern", () => {
      writeArtifact(
        DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM,
        Buffer.from([0x01, 0x02, 0x03])
      )
      expect(containsSwapRevert(oppDirectory)).toBe(false)
    })

    it("finds the SWAP_REVERT tag inside a matching-direction artifact", () => {
      writeArtifact(
        DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM,
        Buffer.from([0xff, ...SwapRevertTagBytes, 0xff])
      )
      expect(containsSwapRevert(oppDirectory)).toBe(true)
    })

    it("ignores artifacts from other directions", () => {
      writeArtifact(
        DebugOutpostEndpointsType.DEPOT_OUTPOST_SOLANA,
        Buffer.from(SwapRevertTagBytes)
      )
      expect(containsSwapRevert(oppDirectory)).toBe(false)
      expect(
        containsSwapRevert(
          oppDirectory,
          DebugOutpostEndpointsType.DEPOT_OUTPOST_SOLANA
        )
      ).toBe(true)
    })

    it("scans for arbitrary attestation tags via envelopeDataContains", () => {
      writeArtifact(
        DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
        Buffer.from([...attestationEntryTag(AttestationType.SWAP_REQUEST)])
      )
      expect(
        envelopeDataContains(
          oppDirectory,
          DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
          attestationEntryTag(AttestationType.SWAP_REQUEST)
        )
      ).toBe(true)
      expect(
        envelopeDataContains(
          oppDirectory,
          DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
          attestationEntryTag(AttestationType.SWAP_REVERT)
        )
      ).toBe(false)
    })
  })

  describe("containsSyndicateLiq / containsLiqYield / containsDesyndicateLiq", () => {
    it("default to the direction each type actually travels", () => {
      writeArtifact(
        DebugOutpostEndpointsType.OUTPOST_SOLANA_DEPOT,
        Buffer.from([...SyndicateLiqTagBytes, ...LiqYieldTagBytes])
      )
      writeArtifact(
        DebugOutpostEndpointsType.DEPOT_OUTPOST_SOLANA,
        Buffer.from(DesyndicateLiqTagBytes),
        2
      )
      expect(containsSyndicateLiq(oppDirectory)).toBe(true)
      expect(containsLiqYield(oppDirectory)).toBe(true)
      expect(containsDesyndicateLiq(oppDirectory)).toBe(true)
    })

    it("is false for a missing directory", () => {
      const absent = Path.join(oppDirectory, "absent")
      expect(containsSyndicateLiq(absent)).toBe(false)
      expect(containsLiqYield(absent)).toBe(false)
      expect(containsDesyndicateLiq(absent)).toBe(false)
    })

    it("does not confuse the three adjacent enum values", () => {
      writeArtifact(
        DebugOutpostEndpointsType.OUTPOST_SOLANA_DEPOT,
        Buffer.from(SyndicateLiqTagBytes)
      )
      expect(containsSyndicateLiq(oppDirectory)).toBe(true)
      expect(containsLiqYield(oppDirectory)).toBe(false)
    })

    it("does not match a syndication tag on the WRONG direction", () => {
      writeArtifact(
        DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
        Buffer.from(SyndicateLiqTagBytes)
      )
      expect(containsSyndicateLiq(oppDirectory)).toBe(false)
      expect(
        containsSyndicateLiq(
          oppDirectory,
          DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT
        )
      ).toBe(true)
    })

    it("does not match DESYNDICATE_LIQ on the outbound Solana edge", () => {
      writeArtifact(
        DebugOutpostEndpointsType.OUTPOST_SOLANA_DEPOT,
        Buffer.from(DesyndicateLiqTagBytes)
      )
      expect(containsDesyndicateLiq(oppDirectory)).toBe(false)
    })
  })
})
