import { PublicKey as SolanaPublicKey } from "@solana/web3.js"
import { WireLcoImportTool } from "@wireio/cluster-tool/tools/wire"
import {
  BootstrapPlatformConfig,
  ChainKind,
  LiqPoolSpec
} from "@wireio/opp-typescript-models"
import { SysioContracts } from "@wireio/sdk-core"
import {
  DoubleGeneratorPublicKey,
  GeneratorPublicKey,
  LcoImportFixture,
  PurchaserAddress,
  SolanaPurchaserAddress,
  SolanaStakerAddress,
  StakerAddress,
  WeiPerEther,
  ethereumSnapshot,
  solanaSnapshot
} from "./lcoImportFixture.js"

/** Raw-byte hex of a base58 Solana key. */
function solanaHex(address: string): string {
  return new SolanaPublicKey(address).toBuffer().toString("hex")
}

describe("WireLcoImportTool", () => {
  const fixture = new LcoImportFixture()

  afterAll(() => fixture.remove())

  describe("createPlan", () => {
    it("returns nothing without an import", () => {
      expect(WireLcoImportTool.createPlan(null)).toBeNull()
    })

    it("derives the Ethereum positions, claims and pool from an opp-snapshot export", () => {
      const plan = WireLcoImportTool.createPlan(fixture.config()),
        { ethereum } = plan
      expect(ethereum.chain).toBe(ChainKind.EVM)
      expect(
        ethereum.syndications.map(spec => [spec.chainCode, spec.tokenCode, spec.pubkey, spec.amount])
      ).toEqual([
        ["ETHEREUM", "LIQETH", GeneratorPublicKey, 3_000_000_000n],
        ["ETHEREUM", "LIQETH", DoubleGeneratorPublicKey, 1_500_000_000n]
      ])
      expect(ethereum.claims).toEqual([
        { native_address: StakerAddress.slice(2), wire_atomic: "1250000000" },
        { native_address: PurchaserAddress.slice(2), wire_atomic: "3000000000" }
      ])
      expect(ethereum.pool).toEqual(
        LiqPoolSpec.create({
          chainCode: "ETHEREUM",
          tokenCode: "LIQETH",
          pairSymbol: "LIQETHP",
          name: "LIQETH/WIRE yield pool",
          description: WireLcoImportTool.poolDescription("LIQETH"),
          initialChainAmount: 2_000_000_000n,
          initialWireAmount: 80_000_000_000_000n,
          fee: 30,
          lockedShares: 0n,
          conversionHorizonSec: 86_400,
          depthCapBps: 50,
          clipFloor: 1_000n,
          custodyTotal: 6_500_000_000n
        })
      )
    })

    it("derives the Solana positions, claims and pool from a genesis export", () => {
      const { solana } = WireLcoImportTool.createPlan(fixture.config())
      expect(solana.chain).toBe(ChainKind.SVM)
      expect(solana.syndications.map(spec => [spec.pubkey, spec.amount])).toEqual([
        [SolanaStakerAddress, 5_000_000_000n]
      ])
      expect(solana.claims).toEqual([
        { native_address: solanaHex(SolanaStakerAddress), wire_atomic: "1200000000" },
        { native_address: solanaHex(SolanaPurchaserAddress), wire_atomic: "3000000000" }
      ])
      expect([
        solana.pool.initialChainAmount,
        solana.pool.initialWireAmount,
        solana.pool.custodyTotal,
        solana.pool.pairSymbol
      ]).toEqual([3_000_000_000n, 6_000_000_000_000n, 8_000_000_000n, "LIQSOLP"])
    })

    it("lists every placeholder it used, and none once every value is set", () => {
      expect(
        WireLcoImportTool.createPlan(fixture.config()).placeholders.map(
          placeholder => placeholder.setting
        )
      ).toEqual([
        `${fixture.path}/ethereum.json: metadata.lastPoolLiqBalance`,
        "lcoImport.ethereum.nativePriceUsd",
        "lcoImport.ethereum.highestTranchePriceUsd",
        "lcoImport.ethereum.pool",
        "lcoImport.solana.nativePriceUsd",
        "lcoImport.solana.highestTranchePriceUsd",
        "lcoImport.solana.pool",
        "lcoImport.dclaimFundingAccount"
      ])
      const exported = ethereumSnapshot(),
        tuning = LiqPoolSpec.create({
          fee: 25,
          conversionHorizonSec: 3_600,
          depthCapBps: 40,
          clipFloor: 10n,
          name: "launch pool"
        })
      exported.metadata.lastPoolLiqBalance = (7n * WeiPerEther).toString()
      exported.metadata.highestTranchePriceUsd = "20000000"
      const solanaExport = solanaSnapshot()
      solanaExport.accounting.highestTranchePriceUsd = "20000000"
      const plan = WireLcoImportTool.createPlan({
        ethereum: {
          ...fixture.chain("priced-ethereum.json", exported),
          nativePriceUsd: "300000000000",
          pool: tuning
        },
        solana: {
          ...fixture.chain("priced-solana.json", solanaExport),
          nativePriceUsd: "15000000000",
          highestTranchePriceUsd: "20000000",
          pool: tuning
        },
        dclaimFundingAccount: "lco.treasury"
      })
      expect(plan.placeholders).toEqual([])
      expect(plan.dclaimFundingAccount).toBe("lco.treasury")
      expect([
        plan.ethereum.pool.custodyTotal,
        plan.ethereum.pool.initialChainAmount,
        plan.ethereum.pool.initialWireAmount,
        plan.ethereum.pool.fee,
        plan.ethereum.pool.name
      ]).toEqual([7_000_000_000n, 2_500_000_000n, 37_500_000_000_000n, 25, "launch pool"])
    })

    it("refuses a staker holding liqETH with no recovered pubkey", () => {
      const exported = ethereumSnapshot()
      exported.stakers[0].pubkey = null
      expect(() =>
        WireLcoImportTool.createPlan({
          ethereum: fixture.chain("keyless.json", exported),
          solana: null,
          dclaimFundingAccount: null
        })
      ).toThrow(new RegExp(`no recovered pubkey.*${StakerAddress}`))
    })

    it("refuses a configured tranche price the export contradicts", () => {
      const exported = ethereumSnapshot()
      exported.metadata.highestTranchePriceUsd = "20000000"
      expect(() =>
        WireLcoImportTool.createPlan({
          ethereum: {
            ...fixture.chain("contradicted.json", exported),
            highestTranchePriceUsd: "30000000"
          },
          solana: null,
          dclaimFundingAccount: null
        })
      ).toThrow(/disagrees with the export's 20000000/)
    })

    it("refuses an export whose syndicated positions use up its custody", () => {
      const exported = ethereumSnapshot()
      exported.metadata.lastPoolLiqBalance = ((9n * WeiPerEther) / 2n).toString()
      expect(() =>
        WireLcoImportTool.createPlan({
          ethereum: fixture.chain("drained.json", exported),
          solana: null,
          dclaimFundingAccount: null
        })
      ).toThrow(/no LCO liq is left for the LIQETH pool/)
    })

    it("refuses a Solana export whose accounting disagrees with its balances, or reports issues", () => {
      const disagreeing = solanaSnapshot(),
        troubled = solanaSnapshot()
      disagreeing.accounting.maxInitialChainAmount = "2000000000"
      troubled.accounting.issues = ["ownerless shares"]
      expect(() =>
        WireLcoImportTool.createPlan({
          ethereum: null,
          solana: fixture.chain("disagreeing.json", disagreeing),
          dclaimFundingAccount: null
        })
      ).toThrow(/maxInitialChainAmount disagrees/)
      expect(() =>
        WireLcoImportTool.createPlan({
          ethereum: null,
          solana: fixture.chain("troubled.json", troubled),
          dclaimFundingAccount: null
        })
      ).toThrow(/reconciliation issues: ownerless shares/)
    })

    it("refuses pool options that set a derived value or a parameter out of range", () => {
      const withPool = (pool: LiqPoolSpec) => ({
        ethereum: { ...fixture.chain("tuned.json", ethereumSnapshot()), pool },
        solana: null,
        dclaimFundingAccount: null
      })
      expect(() =>
        WireLcoImportTool.createPlan(
          withPool(
            LiqPoolSpec.create({
              ...WireLcoImportTool.PlaceholderPoolTuning,
              initialWireAmount: 5n
            })
          )
        )
      ).toThrow(/sets initialWireAmount, which the import derives/)
      expect(() =>
        WireLcoImportTool.createPlan(
          withPool(
            LiqPoolSpec.create({
              ...WireLcoImportTool.PlaceholderPoolTuning,
              depthCapBps: 0
            })
          )
        )
      ).toThrow(/depthCapBps 0 must be 1\.\.10000/)
    })

    it("names the file of a missing or invalid export", () => {
      const missing = `${fixture.path}/absent.json`
      expect(() =>
        WireLcoImportTool.createPlan({
          ethereum: {
            bootstrapJsonFile: missing,
            nativePriceUsd: null,
            highestTranchePriceUsd: null,
            pool: null
          },
          solana: null,
          dclaimFundingAccount: null
        })
      ).toThrow(`cannot read the export ${missing}`)
      expect(() =>
        WireLcoImportTool.createPlan({
          ethereum: null,
          solana: fixture.chain("invalid.json", { schemaVersion: 2 }),
          dclaimFundingAccount: null
        })
      ).toThrow(/invalid\.json is not a valid export/)
    })

    it("merges the positions of one pubkey", () => {
      const exported = ethereumSnapshot()
      exported.stakers[1].pubkey = GeneratorPublicKey
      const { ethereum } = WireLcoImportTool.createPlan({
        ethereum: fixture.chain("merged.json", exported),
        solana: null,
        dclaimFundingAccount: null
      })
      expect(ethereum.syndications.map(spec => [spec.pubkey, spec.amount])).toEqual([
        [GeneratorPublicKey, 4_500_000_000n]
      ])
    })
  })

  describe("batches and records", () => {
    const plan = WireLcoImportTool.createPlan(fixture.config())

    it("splits positions into importsynd pushes with raw-byte pubkeys", () => {
      expect(WireLcoImportTool.syndicationBatch(plan.ethereum, 0)).toEqual({
        chain_code: "ETHEREUM",
        token_code: "LIQETH",
        credits: [
          { pubkey: GeneratorPublicKey.slice(2), amount: "3000000000" },
          { pubkey: DoubleGeneratorPublicKey.slice(2), amount: "1500000000" }
        ]
      })
      expect(WireLcoImportTool.syndicationBatch(plan.solana, 0).credits).toEqual([
        { pubkey: solanaHex(SolanaStakerAddress), amount: "5000000000" }
      ])
      expect(() => WireLcoImportTool.syndicationBatch(plan.ethereum, 1)).toThrow(
        /batch 1 is past the last of 1/
      )
    })

    it("splits claims into importseed pushes on the ABI chain kind", () => {
      expect(WireLcoImportTool.claimBatch(plan.solana, 0)).toEqual({
        chain: SysioContracts.SysioDclaimChainkind.CHAIN_KIND_SVM,
        credits: plan.solana.claims
      })
    })

    it("counts batches, rounding up", () => {
      expect(WireLcoImportTool.batchCount(0, 50)).toBe(0)
      expect(WireLcoImportTool.batchCount(50, 50)).toBe(1)
      expect(WireLcoImportTool.batchCount(51, 50)).toBe(2)
    })

    it("renders a pool as its regliqpool data", () => {
      expect(WireLcoImportTool.poolRegistration(plan.solana)).toEqual({
        chain_code: "SOLANA",
        token_code: "LIQSOL",
        pair_symbol: "9,LIQSOLP",
        initial_chain_amount: "3000000000",
        initial_wire_amount: "6000000000000",
        fee: 30,
        locked_shares: "0",
        conversion_horizon_sec: 86_400,
        depth_cap_bps: 50,
        clip_floor: "1000"
      })
    })

    it("totals and summarizes each chain", () => {
      expect(WireLcoImportTool.chainPlans(plan)).toEqual([plan.ethereum, plan.solana])
      expect(WireLcoImportTool.syndicatedTotal(plan.ethereum)).toBe(4_500_000_000n)
      expect(WireLcoImportTool.claimTotal(plan.solana)).toBe(4_200_000_000n)
      expect(WireLcoImportTool.planClaimTotal(plan)).toBe(8_450_000_000n)
      expect(WireLcoImportTool.summarize(plan).ethereum).toEqual({
        bootstrapJsonFile: `${fixture.path}/ethereum.json`,
        syndicationCount: 2,
        syndicatedTotal: "4500000000",
        claimCount: 2,
        claimTotal: "4250000000",
        poolChainAmount: "2000000000",
        poolWireAmount: "80000000000000"
      })
    })

    it("records every pool and position as a BootstrapPlatformConfig in authored-config JSON", () => {
      const record = WireLcoImportTool.toBootstrapPlatformConfig(plan, "sandbox"),
        json = JSON.parse(WireLcoImportTool.serializeRecord(record))
      expect(record.t5DexAllocation).toBe(80_000_000_000_000n + 6_000_000_000_000n)
      expect(record.syndications).toHaveLength(3)
      expect(json.schema_version).toBe(1)
      expect(json.network).toBe("sandbox")
      expect(json.liq_pools[0].initial_chain_amount).toBe("2000000000")
      expect(json.liq_pools[0].custody_total).toBe("6500000000")
      expect(BootstrapPlatformConfig.fromJson(json)).toEqual(record)
    })

    it("refuses placeholders against real custody, and accepts a plan without them", () => {
      expect(() => WireLcoImportTool.assertRealData(plan)).toThrow(
        /takes real values only — set .*lcoImport\.dclaimFundingAccount/
      )
      expect(() =>
        WireLcoImportTool.assertRealData({ ...plan, placeholders: [] })
      ).not.toThrow()
    })
  })

  describe("unit helpers", () => {
    it("scales amounts between precisions, flooring when precision drops", () => {
      expect(WireLcoImportTool.scaleUnits(1_999_999_999n, 18, 9)).toBe(1n)
      expect(WireLcoImportTool.scaleUnits(12n, 8, 9)).toBe(120n)
      expect(WireLcoImportTool.scaleUnits(5n, 9, 9)).toBe(5n)
    })

    it("renders native values as raw-byte hex and EVM values in display form", () => {
      expect(
        WireLcoImportTool.nativeBytesHex(ChainKind.EVM, "0XABCDEF0000000000000000000000000000000001")
      ).toBe("abcdef0000000000000000000000000000000001")
      expect(
        WireLcoImportTool.nativeBytesHex(ChainKind.EVM, GeneratorPublicKey.slice(2))
      ).toBe(GeneratorPublicKey.slice(2))
      expect(WireLcoImportTool.nativeBytesHex(ChainKind.SVM, SolanaStakerAddress)).toBe(
        solanaHex(SolanaStakerAddress)
      )
      expect(WireLcoImportTool.evmDisplayHex("ABCD")).toBe("0xabcd")
      expect(() => WireLcoImportTool.nativeBytesHex(ChainKind.SVM, "0xabcd")).toThrow()
    })

    it("names and describes a pool by its token", () => {
      expect(WireLcoImportTool.poolName("LIQSOL")).toBe("LIQSOL/WIRE yield pool")
      expect(WireLcoImportTool.poolDescription("LIQSOL")).toContain("LIQSOL")
    })
  })
})
