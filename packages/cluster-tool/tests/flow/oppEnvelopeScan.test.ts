import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import {
  AttestationType,
  DebugEnvelopeMetadataRecord,
  DebugOutpostEndpointsType,
  Envelope,
  LIQYield,
  type AttestationEntry
} from "@wireio/opp-typescript-models"
import {
  attestationEntryTag,
  containsDesyndicateLIQ,
  containsLIQYield,
  containsSwapRevert,
  containsSyndicateLIQ,
  envelopeDataContains,
  readEnvelopeAttestations,
  varintBytes
} from "@wireio/cluster-tool/flow"

/** The known wire encoding of `ATTESTATION_TYPE_SWAP_REVERT` (60955). */
const SwapRevertTagBytes = [0x08, 0x9b, 0xdc, 0x03]
/** The known wire encoding of `ATTESTATION_TYPE_SYNDICATE_LIQ` (60963). */
const SyndicateLIQTagBytes = [0x08, 0xa3, 0xdc, 0x03]
/** The known wire encoding of `ATTESTATION_TYPE_LIQ_YIELD` (60964). */
const LIQYieldTagBytes = [0x08, 0xa4, 0xdc, 0x03]
/** The known wire encoding of `ATTESTATION_TYPE_DESYNDICATE_LIQ` (60965). */
const DesyndicateLIQTagBytes = [0x08, 0xa5, 0xdc, 0x03]
/** liqSOL base units carried by the fixture `LIQYield` payload. */
const FixtureLIQYieldAmount = 25_000_000n
/** SlugName-packed token code carried by the fixture `LIQYield` payload. */
const FixtureLIQYieldTokenCode = 42n
/** Shared-liq-sequence value carried by the fixture `LIQYield` payload. */
const FixtureLIQYieldSequence = 7n
/** Outpost-chain epoch carried by the fixture `LIQYield` payload. */
const FixtureLIQYieldEpoch = 3n
/** SlugName-packed chain code carried by the fixture `LIQYield` payload. */
const FixtureLIQYieldChainCode = 100n

describe("oppEnvelopeScan", () => {
  let oppDirectory: string

  /**
   * Write one artifact PAIR for `direction` carrying `payload`.
   *
   * Both halves, because the cluster writes both and the two scanners consume
   * different ones: the byte-tag scan reads `.data` alone, while
   * `readEnvelopeAttestations` goes through `readEnvelopeRecordsFromDir`, which
   * enumerates `.metadata` keys and reads the pair.
   */
  function writeArtifact(
    direction: DebugOutpostEndpointsType,
    payload: Buffer,
    epoch = 1
  ): void {
    const baseKey = `${String(epoch).padStart(8, "0")}-${DebugOutpostEndpointsType[direction]}-abcdef0123456789`
    Fs.writeFileSync(Path.join(oppDirectory, `${baseKey}.data`), payload)
    Fs.writeFileSync(
      Path.join(oppDirectory, `${baseKey}.metadata`),
      Buffer.from(
        DebugEnvelopeMetadataRecord.toBinary({
          checksum: BigInt(payload.length),
          batchOpNames: []
        })
      )
    )
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
        SyndicateLIQTagBytes
      )
      expect([...attestationEntryTag(AttestationType.LIQ_YIELD)]).toEqual(
        LIQYieldTagBytes
      )
      expect([...attestationEntryTag(AttestationType.DESYNDICATE_LIQ)]).toEqual(
        DesyndicateLIQTagBytes
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

  describe("containsDesyndicateLIQ", () => {
    it("defaults to the depot → Solana direction the redemption travels", () => {
      writeArtifact(
        DebugOutpostEndpointsType.DEPOT_OUTPOST_SOLANA,
        Buffer.from(DesyndicateLIQTagBytes)
      )
      expect(containsDesyndicateLIQ(oppDirectory)).toBe(true)
      expect(
        containsDesyndicateLIQ(
          oppDirectory,
          DebugOutpostEndpointsType.OUTPOST_SOLANA_DEPOT
        )
      ).toBe(false)
    })

    it("is false for a missing directory", () => {
      expect(containsDesyndicateLIQ(Path.join(oppDirectory, "absent"))).toBe(false)
    })

    it("does not match the two inbound liq types", () => {
      writeArtifact(
        DebugOutpostEndpointsType.DEPOT_OUTPOST_SOLANA,
        Buffer.from([...SyndicateLIQTagBytes, ...LIQYieldTagBytes])
      )
      expect(containsDesyndicateLIQ(oppDirectory)).toBe(false)
    })
  })

  describe("containsSyndicateLIQ / containsLIQYield", () => {
    it("default to the direction each type actually travels", () => {
      writeArtifact(
        DebugOutpostEndpointsType.OUTPOST_SOLANA_DEPOT,
        Buffer.from([...SyndicateLIQTagBytes, ...LIQYieldTagBytes])
      )
      expect(containsSyndicateLIQ(oppDirectory)).toBe(true)
      expect(containsLIQYield(oppDirectory)).toBe(true)
    })

    it("is false for a missing directory", () => {
      const absent = Path.join(oppDirectory, "absent")
      expect(containsSyndicateLIQ(absent)).toBe(false)
      expect(containsLIQYield(absent)).toBe(false)
    })

    it("does not confuse the three adjacent enum values", () => {
      writeArtifact(
        DebugOutpostEndpointsType.OUTPOST_SOLANA_DEPOT,
        Buffer.from(SyndicateLIQTagBytes)
      )
      expect(containsSyndicateLIQ(oppDirectory)).toBe(true)
      expect(containsLIQYield(oppDirectory)).toBe(false)
    })

    it("does not match a syndication tag on the WRONG direction", () => {
      writeArtifact(
        DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
        Buffer.from(SyndicateLIQTagBytes)
      )
      expect(containsSyndicateLIQ(oppDirectory)).toBe(false)
      expect(
        containsSyndicateLIQ(
          oppDirectory,
          DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT
        )
      ).toBe(true)
    })

    it("does not match a DESYNDICATE_LIQ tag as either outbound liq type", () => {
      writeArtifact(
        DebugOutpostEndpointsType.OUTPOST_SOLANA_DEPOT,
        Buffer.from(DesyndicateLIQTagBytes)
      )
      expect(containsSyndicateLIQ(oppDirectory)).toBe(false)
      expect(containsLIQYield(oppDirectory)).toBe(false)
    })
  })

  describe("readEnvelopeAttestations", () => {
    /** One `AttestationEntry` with its `dataSize` derived from the payload. */
    function entry(type: AttestationType, data: Uint8Array): AttestationEntry {
      return { type, dataSize: data.length, data }
    }

    /** A one-message envelope carrying `attestations`, serialized as a `.data` artifact would be. */
    function envelopeBytes(attestations: AttestationEntry[]): Buffer {
      return Buffer.from(
        Envelope.toBinary({
          envelopeHash: new Uint8Array(),
          epochTimestamp: 0n,
          epochIndex: 1,
          epochEnvelopeIndex: 0,
          previousEnvelopeHash: new Uint8Array(),
          messages: [
            { header: undefined, payload: { version: 0, attestations } }
          ]
        })
      )
    }

    /** The fixture `LIQYield` payload every case below round-trips. */
    const liqYieldPayload = LIQYield.toBinary({
      chainCode: FixtureLIQYieldChainCode,
      amount: {
        tokenCode: FixtureLIQYieldTokenCode,
        amount: FixtureLIQYieldAmount
      },
      sequence: FixtureLIQYieldSequence,
      epoch: FixtureLIQYieldEpoch
    })

    it("is empty for a missing directory", async () => {
      await expect(
        readEnvelopeAttestations(
          Path.join(oppDirectory, "absent"),
          DebugOutpostEndpointsType.OUTPOST_SOLANA_DEPOT,
          AttestationType.LIQ_YIELD
        )
      ).resolves.toEqual([])
    })

    it("returns the payload of every matching attestation, decodable by its message class", async () => {
      writeArtifact(
        DebugOutpostEndpointsType.OUTPOST_SOLANA_DEPOT,
        envelopeBytes([
          entry(AttestationType.SYNDICATE_LIQ, Uint8Array.of(1, 2)),
          entry(AttestationType.LIQ_YIELD, liqYieldPayload)
        ])
      )
      const payloads = await readEnvelopeAttestations(
        oppDirectory,
        DebugOutpostEndpointsType.OUTPOST_SOLANA_DEPOT,
        AttestationType.LIQ_YIELD
      )
      expect(payloads).toHaveLength(1)
      const decoded = LIQYield.fromBinary(payloads[0])
      expect(decoded.amount.amount).toBe(FixtureLIQYieldAmount)
      expect(decoded.amount.tokenCode).toBe(FixtureLIQYieldTokenCode)
      expect(decoded.sequence).toBe(FixtureLIQYieldSequence)
    })

    it("ignores other directions and other types", async () => {
      writeArtifact(
        DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
        envelopeBytes([entry(AttestationType.LIQ_YIELD, liqYieldPayload)])
      )
      await expect(
        readEnvelopeAttestations(
          oppDirectory,
          DebugOutpostEndpointsType.OUTPOST_SOLANA_DEPOT,
          AttestationType.LIQ_YIELD
        )
      ).resolves.toEqual([])
      await expect(
        readEnvelopeAttestations(
          oppDirectory,
          DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
          AttestationType.SYNDICATE_LIQ
        )
      ).resolves.toEqual([])
    })

    it("skips an artifact that does not decode rather than throwing", async () => {
      writeArtifact(
        DebugOutpostEndpointsType.OUTPOST_SOLANA_DEPOT,
        Buffer.from([0xff, 0xff, 0xff, 0xff]),
        2
      )
      writeArtifact(
        DebugOutpostEndpointsType.OUTPOST_SOLANA_DEPOT,
        envelopeBytes([entry(AttestationType.LIQ_YIELD, liqYieldPayload)]),
        3
      )
      await expect(
        readEnvelopeAttestations(
          oppDirectory,
          DebugOutpostEndpointsType.OUTPOST_SOLANA_DEPOT,
          AttestationType.LIQ_YIELD
        )
      ).resolves.toHaveLength(1)
    })
  })
})
