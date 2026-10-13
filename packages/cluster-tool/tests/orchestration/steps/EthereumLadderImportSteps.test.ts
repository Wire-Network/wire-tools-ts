import { SysioContracts } from "@wireio/sdk-core"
import { ClusterBuild, ClusterBuildContext } from "@wireio/cluster-tool/orchestration"
import { Steps, EthereumLadderImportSteps } from "@wireio/cluster-tool/orchestration/steps"
import { EthereumPreLaunchSteps } from "@wireio/cluster-tool/orchestration/ethereum"
import { EthereumLadderImportKey } from "@wireio/cluster-tool/orchestration/outputs"
import { EthereumSyndicationTool } from "@wireio/cluster-tool/tools/ethereum"
import { WireSyndicationTool } from "@wireio/cluster-tool/tools/wire"
import { getLogger } from "@wireio/cluster-tool/logging"
import { fixtureConfig } from "../../config/clusterConfigFixture.js"

/** The snapshot shape the derivation consumes — capital-index's `/opp/balances`, typed through the step. */
type OppSnapshot = Parameters<typeof EthereumLadderImportSteps.deriveImport>[0]

const SyndContractSteps = Steps.contracts.sysio.synd
const DclaimContractSteps = Steps.contracts.sysio.dclaim
const signal = new AbortController().signal
/** 1 liqETH, 18 decimals. */
const Ether = 10n ** 18n
const StakerA = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8"
const StakerB = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc"
const PubkeyA = "0x02" + "aa".repeat(32)
const PubkeyB = "0x03" + "bb".repeat(32)

/** A snapshot in the `/opp/balances` shape: two stakers, one purchaser. */
function snapshot(overrides: Partial<OppSnapshot> = {}): OppSnapshot {
  return {
    stakers: [
      staker(StakerA, PubkeyA, 5n * Ether + 7n, "1000000000000000000"),
      staker(StakerB, PubkeyB, 3n * Ether, "0")
    ],
    purchasers: [
      {
        address: "0x90f79bf6eb2c4f870365e785982e1f101e93b906",
        pretokens: "123000000000000000000",
        liqShares: "2000000000000000000",
        liqPrincipalIn: "2000000000000000000",
        yieldClaimed: "0",
        pretokenYield: "0",
        totalPretokens: "123000000000000000000"
      }
    ],
    metadata: {
      lastMessageId: "0x01",
      lastTimestamp: "1",
      latestIndex: "1000000000000000000000000000",
      totalMessages: 3,
      totalPrincipal: (8n * Ether + 7n).toString(),
      yieldDust: "0",
      totalLiqEthStaked: (8n * Ether + 7n).toString(),
      totalLiqEthPurchased: (2n * Ether).toString(),
      generatedAt: "2026-10-12T00:00:00.000Z"
    },
    ...overrides
  }
}

function staker(address: string, pubkey: string | null, principalWei: bigint, pretokenYield: string) {
  return {
    address,
    pubkey,
    totalShares: principalWei.toString(),
    totalPrincipalIn: principalWei.toString(),
    totalAmountOut: "0",
    netPrincipal: principalWei.toString(),
    yieldClaimed: "0",
    pretokenYield
  }
}

describe("EthereumLadderImportSteps", () => {
  let context: ClusterBuildContext
  beforeEach(() => {
    context = new ClusterBuildContext(fixtureConfig(), getLogger("ladder-import-test"))
  })
  afterEach(() => jest.restoreAllMocks())

  describe("derivation", () => {
    it("credits each staker's net principal in the depot frame, keyed by the bare compressed pubkey", () => {
      const credits = EthereumLadderImportSteps.syndicationCredits(snapshot())
      expect(credits).toEqual([
        { pubkey: PubkeyA.slice(2), amount: "5000000000" },
        { pubkey: PubkeyB.slice(2), amount: "3000000000" }
      ])
    })

    it("drops a position that floors to nothing and refuses a staker with no recovered key", () => {
      expect(
        EthereumLadderImportSteps.syndicationCredits(
          snapshot({ stakers: [staker(StakerA, PubkeyA, 999_999_999n, "0")] })
        )
      ).toEqual([])
      expect(() =>
        EthereumLadderImportSteps.syndicationCredits(
          snapshot({ stakers: [staker(StakerA, null, Ether, "0")] })
        )
      ).toThrow(/no recovered public key/)
    })

    it("seeds the pool with the booked custody net of the credits, so the dust lands in the shadow", () => {
      const bookedWei = 83n * Ether + 240_000_000_000_000_000n + 123n, // 83.24 liqETH + sub-unit dust
        booked = EthereumLadderImportSteps.bookedDepotUnits(bookedWei),
        credits = EthereumLadderImportSteps.syndicationCredits(snapshot())
      expect(booked).toBe(83_240_000_000n)
      expect(EthereumLadderImportSteps.initialChainAmount(booked, credits)).toBe(
        83_240_000_000n - 5_000_000_000n - 3_000_000_000n
      )
    })

    it("refuses a booked figure the imported positions exceed", () => {
      expect(() =>
        EthereumLadderImportSteps.initialChainAmount(
          1_000_000_000n,
          EthereumLadderImportSteps.syndicationCredits(snapshot())
        )
      ).toThrow(/exceed the booked figure/)
    })

    it("derives the whole import, the dclaim seed through the launch converter", () => {
      const derived = EthereumLadderImportSteps.deriveImport(snapshot(), 83n * Ether)
      expect(derived.bookedDepotUnits).toBe(83_000_000_000n)
      expect(derived.credits).toHaveLength(2)
      expect(derived.initialChainAmount).toBe(75_000_000_000n)
      expect(derived.importseed).toHaveLength(1)
      const [batch] = derived.importseed
      expect(batch.chain).toBe(SysioContracts.SysioDclaimChainkind.CHAIN_KIND_EVM)
      // the purchaser's totalPretokens and staker A's pretokenYield, each 1e18 → 1e9
      expect(batch.credits).toEqual(
        expect.arrayContaining([
          { native_address: "90f79bf6eb2c4f870365e785982e1f101e93b906", wire_atomic: "123000000000" },
          { native_address: StakerA.slice(2), wire_atomic: "1000000000" }
        ])
      )
      expect(derived.importseedTotalAtomic).toBe(124_000_000_000n)
    })
  })

  describe("composition", () => {
    it("plans the snapshot, the pool, one importsynd per staker, the seal, the verify, the seed and its seal", () => {
      const phase = EthereumLadderImportSteps.planImport(
        ClusterBuild.forContext(context),
        "import",
        "import",
        {},
        { mockSolanaCredit: false }
      )
      expect(phase.steps.map(step => step.runner)).toEqual([
        EthereumLadderImportSteps.runSnapshot,
        EthereumLadderImportSteps.runLiqPool,
        ...Array(EthereumPreLaunchSteps.StakerCount).fill(EthereumLadderImportSteps.runImportsyndCredit),
        SyndContractSteps.runImportdone,
        expect.any(Function),
        EthereumLadderImportSteps.runImportseedBatch,
        DclaimContractSteps.runImportdone
      ])
      expect(phase.steps.map(step => step.name)).toContain("verify-ladder-import")
    })

    it("adds the mock bonder and its LIQSOL credit before the seal when asked", () => {
      const names = EthereumLadderImportSteps.planImport(
        ClusterBuild.forContext(context),
        "import",
        "import",
        {},
        { mockSolanaCredit: true }
      ).steps.map(step => step.name)
      expect(names.indexOf("materialize-mock-syndication-bonder")).toBeLessThan(names.indexOf("import-syndication-liqsol"))
      expect(names.indexOf("import-syndication-liqsol")).toBeLessThan(names.indexOf("seal-syndication-import"))
      expect(names.indexOf("import-syndication-liqsol")).toBeGreaterThan(names.indexOf("import-syndication-liqeth-0"))
    })
  })

  describe("runners", () => {
    const derived = EthereumLadderImportSteps.deriveImport(snapshot(), 83n * Ether)

    it("pushes the indexed credit to importsynd for the Ethereum shadow pair", async () => {
      context.outputs.set(EthereumLadderImportKey, derived)
      const importsynd = jest.spyOn(SyndContractSteps, "runImportsynd").mockResolvedValue(undefined)
      await EthereumLadderImportSteps.runImportsyndCredit(
        context,
        { kind: "EthereumLadderImportSteps.CreditInput", creditIndex: 1 },
        signal
      )
      expect(importsynd).toHaveBeenCalledWith(
        context,
        {
          kind: "SyndContractSteps.ImportsyndInput",
          data: { chain_code: "ETHEREUM", token_code: "LIQETH", credits: [derived.credits[1]] }
        },
        signal
      )
    })

    it("refuses a credit index the snapshot did not yield", async () => {
      context.outputs.set(EthereumLadderImportKey, derived)
      jest.spyOn(SyndContractSteps, "runImportsynd").mockResolvedValue(undefined)
      await expect(
        EthereumLadderImportSteps.runImportsyndCredit(
          context,
          { kind: "EthereumLadderImportSteps.CreditInput", creditIndex: 2 },
          signal
        )
      ).rejects.toThrow(/no credit 2/)
    })

    it("registers the Ethereum pool with the derived shadow seed", async () => {
      context.outputs.set(EthereumLadderImportKey, derived)
      const regliqpool = jest.spyOn(Steps.contracts.sysio.liq, "runRegliqpool").mockResolvedValue(undefined)
      await EthereumLadderImportSteps.runLiqPool(context, null, signal)
      expect(regliqpool).toHaveBeenCalledTimes(1)
      const [, input] = regliqpool.mock.calls[0]
      expect(input.data.chain_code).toBe("ETHEREUM")
      expect(input.data.token_code).toBe("LIQETH")
      expect(input.data.initial_chain_amount).toBe("75000000000")
    })

    it("pushes the one dclaim batch and refuses a count a single Step cannot cover", async () => {
      context.outputs.set(EthereumLadderImportKey, derived)
      const importseed = jest.spyOn(DclaimContractSteps, "runImportseed").mockResolvedValue(undefined)
      await EthereumLadderImportSteps.runImportseedBatch(
        context,
        { kind: "EthereumLadderImportSteps.SeedBatchInput", batchIndex: 0 },
        signal
      )
      expect(importseed).toHaveBeenCalledWith(
        context,
        { kind: "DclaimContractSteps.ImportseedInput", data: derived.importseed[0] },
        signal
      )
      context.outputs.set(EthereumLadderImportKey, {
        ...derived,
        importseed: [...derived.importseed, ...derived.importseed]
      })
      await expect(
        EthereumLadderImportSteps.runImportseedBatch(
          context,
          { kind: "EthereumLadderImportSteps.SeedBatchInput", batchIndex: 0 },
          signal
        )
      ).rejects.toThrow(/dclaim batches/)
    })

    it("verifies the depot's outstanding against the booked figure, and the pool's principal after the go-live", async () => {
      context.outputs.set(EthereumLadderImportKey, derived)
      const outstanding = jest.spyOn(WireSyndicationTool, "readOutstanding").mockResolvedValue(83_000_000_000n),
        principal = jest.spyOn(EthereumSyndicationTool, "readSyndicatedPrincipal").mockResolvedValue(83_000_000_000n)
      await expect(EthereumLadderImportSteps.assertOutstandingEqualsBooked(context)).resolves.toBeUndefined()
      await expect(EthereumLadderImportSteps.assertPoolSeededFromBooked(context)).resolves.toBeUndefined()
      expect(outstanding).toHaveBeenCalledWith(context, "LIQETH")
      outstanding.mockResolvedValue(82_999_999_999n)
      await expect(EthereumLadderImportSteps.assertOutstandingEqualsBooked(context)).rejects.toThrow(/booked figure/)
      principal.mockResolvedValue(1n)
      await expect(EthereumLadderImportSteps.assertPoolSeededFromBooked(context)).rejects.toThrow(/principal/)
    })
  })
})
