import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import {
  AttestationType,
  DebugOutpostEndpointsType,
  LIQYield
} from "@wireio/opp-typescript-models"
import {
  attestationEntryTag,
  containsDesyndicateLIQ,
  containsLIQYield,
  containsSyndicateLIQ,
  envelopeDataContains,
  readEnvelopeAttestations,
  varintBytes
} from "@wireio/cluster-tool/flow"
import {
  attestationEntry,
  envelopeBytes,
  writeOppArtifact
} from "./oppArtifactFixture.js"

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
/** The fixture `LIQYield`'s outpost-side syndicated total at the claim. */
const FixtureLIQYieldTotalSyndicated = 500_000_000n

describe("oppEnvelopeScan", () => {
  let oppDirectory: string

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
      expect(varintBytes(AttestationType.SYNDICATE_LIQ)).toEqual(
        SyndicateLIQTagBytes.slice(1)
      )
    })
  })

  describe("attestationEntryTag", () => {
    it("prefixes the field-1 varint tag to each liq-syndication type's varint", () => {
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

  describe("envelopeDataContains", () => {
    it("is false for a missing directory", () => {
      expect(
        envelopeDataContains(
          Path.join(oppDirectory, "absent"),
          DebugOutpostEndpointsType.OUTPOST_SOLANA_DEPOT,
          attestationEntryTag(AttestationType.SYNDICATE_LIQ)
        )
      ).toBe(false)
    })

    it("is false when no artifact carries the pattern", () => {
      writeOppArtifact(
        oppDirectory,
        DebugOutpostEndpointsType.OUTPOST_SOLANA_DEPOT,
        Buffer.from([0x01, 0x02, 0x03])
      )
      expect(
        envelopeDataContains(
          oppDirectory,
          DebugOutpostEndpointsType.OUTPOST_SOLANA_DEPOT,
          attestationEntryTag(AttestationType.SYNDICATE_LIQ)
        )
      ).toBe(false)
    })

    it("finds the tag inside a matching-direction artifact", () => {
      writeOppArtifact(
        oppDirectory,
        DebugOutpostEndpointsType.OUTPOST_SOLANA_DEPOT,
        Buffer.from([0xff, ...SyndicateLIQTagBytes, 0xff])
      )
      expect(
        envelopeDataContains(
          oppDirectory,
          DebugOutpostEndpointsType.OUTPOST_SOLANA_DEPOT,
          attestationEntryTag(AttestationType.SYNDICATE_LIQ)
        )
      ).toBe(true)
    })

    it("ignores artifacts from other directions", () => {
      writeOppArtifact(
        oppDirectory,
        DebugOutpostEndpointsType.DEPOT_OUTPOST_SOLANA,
        Buffer.from(SyndicateLIQTagBytes)
      )
      expect(
        envelopeDataContains(
          oppDirectory,
          DebugOutpostEndpointsType.OUTPOST_SOLANA_DEPOT,
          attestationEntryTag(AttestationType.SYNDICATE_LIQ)
        )
      ).toBe(false)
      expect(
        envelopeDataContains(
          oppDirectory,
          DebugOutpostEndpointsType.DEPOT_OUTPOST_SOLANA,
          attestationEntryTag(AttestationType.SYNDICATE_LIQ)
        )
      ).toBe(true)
    })

    it("distinguishes attestation types by their tag", () => {
      writeOppArtifact(
        oppDirectory,
        DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
        Buffer.from([...attestationEntryTag(AttestationType.LIQ_YIELD)])
      )
      expect(
        envelopeDataContains(
          oppDirectory,
          DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
          attestationEntryTag(AttestationType.LIQ_YIELD)
        )
      ).toBe(true)
      expect(
        envelopeDataContains(
          oppDirectory,
          DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
          attestationEntryTag(AttestationType.DESYNDICATE_LIQ)
        )
      ).toBe(false)
    })
  })

  describe("containsDesyndicateLIQ", () => {
    it("defaults to the depot → Solana direction the redemption travels", () => {
      writeOppArtifact(
        oppDirectory,
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
      writeOppArtifact(
        oppDirectory,
        DebugOutpostEndpointsType.DEPOT_OUTPOST_SOLANA,
        Buffer.from([...SyndicateLIQTagBytes, ...LIQYieldTagBytes])
      )
      expect(containsDesyndicateLIQ(oppDirectory)).toBe(false)
    })
  })

  describe("containsSyndicateLIQ / containsLIQYield", () => {
    it("default to the direction each type actually travels", () => {
      writeOppArtifact(
        oppDirectory,
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
      writeOppArtifact(
        oppDirectory,
        DebugOutpostEndpointsType.OUTPOST_SOLANA_DEPOT,
        Buffer.from(SyndicateLIQTagBytes)
      )
      expect(containsSyndicateLIQ(oppDirectory)).toBe(true)
      expect(containsLIQYield(oppDirectory)).toBe(false)
    })

    it("does not match a syndication tag on the WRONG direction", () => {
      writeOppArtifact(
        oppDirectory,
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
      writeOppArtifact(
        oppDirectory,
        DebugOutpostEndpointsType.OUTPOST_SOLANA_DEPOT,
        Buffer.from(DesyndicateLIQTagBytes)
      )
      expect(containsSyndicateLIQ(oppDirectory)).toBe(false)
      expect(containsLIQYield(oppDirectory)).toBe(false)
    })
  })

  describe("readEnvelopeAttestations", () => {
    /** The fixture `LIQYield` payload every case below round-trips. */
    const liqYieldPayload = LIQYield.toBinary({
      chainCode: FixtureLIQYieldChainCode,
      amount: {
        tokenCode: FixtureLIQYieldTokenCode,
        amount: FixtureLIQYieldAmount
      },
      sequence: FixtureLIQYieldSequence,
      epoch: FixtureLIQYieldEpoch,
      totalSyndicated: FixtureLIQYieldTotalSyndicated
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
      writeOppArtifact(
        oppDirectory,
        DebugOutpostEndpointsType.OUTPOST_SOLANA_DEPOT,
        envelopeBytes([
          attestationEntry(AttestationType.SYNDICATE_LIQ, Uint8Array.of(1, 2)),
          attestationEntry(AttestationType.LIQ_YIELD, liqYieldPayload)
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
      expect(decoded.totalSyndicated).toBe(FixtureLIQYieldTotalSyndicated)
    })

    it("ignores other directions and other types", async () => {
      writeOppArtifact(
        oppDirectory,
        DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
        envelopeBytes([
          attestationEntry(AttestationType.LIQ_YIELD, liqYieldPayload)
        ])
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
      writeOppArtifact(
        oppDirectory,
        DebugOutpostEndpointsType.OUTPOST_SOLANA_DEPOT,
        Buffer.from([0xff, 0xff, 0xff, 0xff]),
        2
      )
      writeOppArtifact(
        oppDirectory,
        DebugOutpostEndpointsType.OUTPOST_SOLANA_DEPOT,
        envelopeBytes([
          attestationEntry(AttestationType.LIQ_YIELD, liqYieldPayload)
        ]),
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
