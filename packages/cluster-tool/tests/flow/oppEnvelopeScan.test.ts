import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import {
  AttestationType,
  DebugOutpostEndpointsType
} from "@wireio/opp-typescript-models"
import {
  attestationEntryTag,
  containsSwapRevert,
  envelopeDataContains,
  varintBytes
} from "@wireio/cluster-tool/flow"

/** The known wire encoding of `ATTESTATION_TYPE_SWAP_REVERT` (60955). */
const SwapRevertTagBytes = [0x08, 0x9b, 0xdc, 0x03]

describe("oppEnvelopeScan", () => {
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
  })

  describe("envelopeDataContains / containsSwapRevert", () => {
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
})
