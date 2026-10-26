import { PublicKey as SolanaPublicKey } from "@solana/web3.js"
import { WireLcoImportTool } from "@wireio/cluster-tool/tools/wire"
import {
  BootstrapPlatformConfig,
  ChainKind,
  LiqPoolSpec
} from "@wireio/opp-typescript-models"
import { SysioContracts } from "@wireio/sdk-core"
import { fixtureExternalOutposts } from "../../config/resolveEnvironmentFixture.js"
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
  solanaSnapshot,
  withAllocationHash,
  withEthereumTotals
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
        { native_address: PurchaserAddress.slice(2), wire_atomic: "3000000000" },
        { native_address: StakerAddress.slice(2), wire_atomic: "1250000000" }
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
      ]).toEqual([1_000_000_000n, 2_000_000_000_000n, 6_000_000_000n, "LIQSOLP"])
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

    it("books placeholder custody as the imported positions plus the purchases, so sub-unit principal never reaches the pool", () => {
      // 0.6 gwei under each position: floored per position, but 1.2 gwei once summed raw.
      const exported = ethereumSnapshot()
      exported.stakers[0].netPrincipal = (3n * WeiPerEther + 600_000_000n).toString()
      exported.stakers[1].netPrincipal = (
        (3n * WeiPerEther) / 2n +
        600_000_000n
      ).toString()
      withEthereumTotals(exported)
      const { ethereum, placeholders } = WireLcoImportTool.createPlan({
        ethereum: fixture.chain("remainders.json", exported),
        solana: null,
        dclaimFundingAccount: null
      })
      expect([
        ethereum.pool.custodyTotal,
        ethereum.pool.initialChainAmount
      ]).toEqual([6_500_000_000n, 2_000_000_000n])
      expect(placeholders[0].value).toBe(((13n * WeiPerEther) / 2n).toString())
      exported.purchasers.forEach(purchaser => {
        purchaser.liqPrincipalIn = "0"
      })
      withEthereumTotals(exported)
      expect(() =>
        WireLcoImportTool.createPlan({
          ethereum: fixture.chain("unpurchased.json", exported),
          solana: null,
          dclaimFundingAccount: null
        })
      ).toThrow(/no LCO liq is left for the LIQETH pool/)
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

    it("refuses a staker whose pubkey is not its address's key", () => {
      const exported = ethereumSnapshot()
      exported.stakers[0].address = PurchaserAddress
      expect(() =>
        WireLcoImportTool.createPlan({
          ethereum: fixture.chain("mis-keyed.json", exported),
          solana: null,
          dclaimFundingAccount: null
        })
      ).toThrow(new RegExp(`not their address's key: ${PurchaserAddress}`))
    })

    it("refuses a Solana export whose balances do not hash to its allocationHash", () => {
      const altered = solanaSnapshot()
      altered.balances[0].syndicatedLiqsol = "6000000000"
      expect(() =>
        WireLcoImportTool.createPlan({
          ethereum: null,
          solana: fixture.chain("altered.json", altered),
          dclaimFundingAccount: null
        })
      ).toThrow(
        new RegExp(`not the declared allocationHash ${altered.allocationHash}`)
      )
    })

    it("refuses a Solana pool principal the wallets did not purchase", () => {
      const inflated = solanaSnapshot()
      inflated.accounting.initialChainAmount = "2000000000"
      expect(() =>
        WireLcoImportTool.createPlan({
          ethereum: null,
          solana: fixture.chain("inflated.json", inflated),
          dclaimFundingAccount: null
        })
      ).toThrow(
        /totals disagree with the rows: accounting\.initialChainAmount 2000000000 \(rows: 1000000000\)/
      )
    })

    it("refuses a booked custody or a claim total beyond the asset range", () => {
      // Two positions at the asset maximum each: the pool stays small, its custody does not.
      const overbooked = ethereumSnapshot(),
        maxPosition = (WireLcoImportTool.AssetMaxAmount * 10n ** 9n).toString()
      overbooked.stakers[0].netPrincipal = maxPosition
      overbooked.stakers[1].netPrincipal = maxPosition
      withEthereumTotals(overbooked)
      expect(() =>
        WireLcoImportTool.createPlan({
          ethereum: fixture.chain("huge-custody.json", overbooked),
          solana: null,
          dclaimFundingAccount: null
        })
      ).toThrow(/LIQETH pool: its booked custody \d+ exceeds the asset range/)
      const claimed = ethereumSnapshot(),
        maxClaim = (WireLcoImportTool.AssetMaxAmount * 10n ** 9n).toString()
      claimed.stakers[0].pretokenYield = "0"
      claimed.purchasers.forEach(purchaser => {
        purchaser.pretokens = maxClaim
        purchaser.totalPretokens = maxClaim
      })
      expect(() =>
        WireLcoImportTool.createPlan({
          ethereum: fixture.chain("huge-claims.json", claimed),
          solana: null,
          dclaimFundingAccount: null
        })
      ).toThrow(/the claims total \d+ WIRE subunits, beyond the asset range/)
    })

    it("refuses a row whose totalPretokens is not its parts", () => {
      const ethereum = ethereumSnapshot(),
        solana = solanaSnapshot()
      ethereum.purchasers[0].totalPretokens = (999n * WeiPerEther).toString()
      solana.balances[1].totalPretokens = "99900000000"
      withAllocationHash(solana)
      expect(() =>
        WireLcoImportTool.createPlan({
          ethereum: fixture.chain("inflated-claim.json", ethereum),
          solana: null,
          dclaimFundingAccount: null
        })
      ).toThrow(
        new RegExp(`1 row\\(s\\) whose totalPretokens is not its pretokens plus pretokenYield: ${PurchaserAddress}`)
      )
      expect(() =>
        WireLcoImportTool.createPlan({
          ethereum: null,
          solana: fixture.chain("inflated-claim.json", solana),
          dclaimFundingAccount: null
        })
      ).toThrow(new RegExp(`pretokens plus pretokenYield: ${SolanaPurchaserAddress}`))
    })

    it("refuses declared totals the rows do not add up to", () => {
      const ethereum = ethereumSnapshot(),
        solana = solanaSnapshot()
      ethereum.metadata.totalLiqEthPurchased = (5n * WeiPerEther).toString()
      solana.accounting.totalUserPretokens = "1"
      expect(() =>
        WireLcoImportTool.createPlan({
          ethereum: fixture.chain("wrong-purchased.json", ethereum),
          solana: null,
          dclaimFundingAccount: null
        })
      ).toThrow(
        /totals disagree with the rows: metadata\.totalLiqEthPurchased 5000000000000000000 \(rows: 2000000000000000000\)/
      )
      expect(() =>
        WireLcoImportTool.createPlan({
          ethereum: null,
          solana: fixture.chain("wrong-user-pretokens.json", solana),
          dclaimFundingAccount: null
        })
      ).toThrow(/accounting\.totalUserPretokens 1 \(rows: 420000000\)/)
    })

    it("derives the Solana backing from the pool balance and its unreported yield", () => {
      const drained = solanaSnapshot(),
        stale = solanaSnapshot()
      drained.accounting.poolBalance = "1"
      stale.accounting.poolBalance = "8500000000"
      expect(() =>
        WireLcoImportTool.createPlan({
          ethereum: null,
          solana: fixture.chain("drained-pool.json", drained),
          dclaimFundingAccount: null
        })
      ).toThrow(/the pool's 1 liqSOL is less than its 1000000000 unreported yield/)
      expect(() =>
        WireLcoImportTool.createPlan({
          ethereum: null,
          solana: fixture.chain("stale-backing.json", stale),
          dclaimFundingAccount: null
        })
      ).toThrow(/accounting\.backingAvailable 8000000000 \(rows: 7500000000\)/)
    })

    it("accepts a staker pubkey with or without its 0x prefix", () => {
      const exported = ethereumSnapshot()
      exported.stakers[0].pubkey = GeneratorPublicKey.slice(2)
      expect(
        WireLcoImportTool.createPlan({
          ethereum: fixture.chain("unprefixed.json", exported),
          solana: null,
          dclaimFundingAccount: null
        }).ethereum.syndications.map(spec => spec.pubkey)
      ).toContain(GeneratorPublicKey)
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

    it("refuses a Solana export whose booked principal exceeds its backing, or reports issues", () => {
      const overbooked = solanaSnapshot(),
        troubled = solanaSnapshot()
      overbooked.balances[1].purchasedLiqsol = "4000000000"
      overbooked.accounting.initialChainAmount = "4000000000"
      withAllocationHash(overbooked)
      troubled.accounting.issues = ["ownerless shares"]
      expect(() =>
        WireLcoImportTool.createPlan({
          ethereum: null,
          solana: fixture.chain("overbooked.json", overbooked),
          dclaimFundingAccount: null
        })
      ).toThrow(/booked principal 9000000000 exceeds the 8000000000 the pool can back/)
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

    it("holds a pool to sysio.swap's own limits: seeds below 10^15, a share for the creator", () => {
      const tuned = (tuning: Partial<LiqPoolSpec>, nativePriceUsd: string = null) =>
        WireLcoImportTool.createPlan({
          ethereum: {
            ...fixture.chain("swap-limits.json", ethereumSnapshot()),
            nativePriceUsd,
            pool: LiqPoolSpec.create({
              ...WireLcoImportTool.PlaceholderPoolTuning,
              ...tuning
            })
          },
          solana: null,
          dclaimFundingAccount: null
        })
      // 2 LIQETH against 80,000 WIRE mints isqrt(2e9 × 8e13) = 4e11 shares.
      expect(tuned({ lockedShares: 399_999_999_999n }).ethereum.pool.lockedShares).toBe(
        399_999_999_999n
      )
      expect(() => tuned({ lockedShares: 400_000_000_000n })).toThrow(
        /lockedShares 400000000000 must stay below the 400000000000 minted pool shares/
      )
      expect(() =>
        tuned({ clipFloor: WireLcoImportTool.AssetMaxAmount + 1n })
      ).toThrow(/clipFloor must be positive and within the asset range/)
      // At $50,000 an ETH, 2 LIQETH is worth 1,000,000 WIRE: 10^15 subunits, the limit.
      expect(() => tuned({}, "5000000000000")).toThrow(
        /a seed reaches sysio\.swap's 1000000000000000 limit \(liq 2000000000, WIRE 1000000000000000\)/
      )
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
      exported.stakers[1].address = StakerAddress
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

    it("names a row's chain by the plan's chain code, whichever spelling the node used", () => {
      const chains = WireLcoImportTool.chainPlans(plan),
        { SysioSyndChainkind } = SysioContracts
      expect(
        WireLcoImportTool.chainCodeOf(chains, "CHAIN_KIND_SVM", SysioSyndChainkind)
      ).toBe("SOLANA")
      expect(
        WireLcoImportTool.chainCodeOf(
          chains,
          SysioSyndChainkind.CHAIN_KIND_EVM,
          SysioSyndChainkind
        )
      ).toBe("ETHEREUM")
      expect(
        WireLcoImportTool.chainCodeOf(chains, "CHAIN_KIND_WIRE", SysioSyndChainkind)
      ).toBe("CHAIN_KIND_WIRE")
    })

    it("counts each batch's credits as the batch itself carries them", () => {
      expect(
        [0, 1, 2].map(index => WireLcoImportTool.batchCreditCount(101, 50, index))
      ).toEqual([50, 50, 1])
      expect(WireLcoImportTool.batchCreditCount(50, 50, 0)).toBe(50)
      expect(WireLcoImportTool.batchCreditCount(2, 50, 0)).toBe(
        WireLcoImportTool.syndicationBatch(plan.ethereum, 0).credits.length
      )
    })

    it("renders a pool as its regliqpool data", () => {
      expect(WireLcoImportTool.poolRegistration(plan.solana)).toEqual({
        chain_code: "SOLANA",
        token_code: "LIQSOL",
        pair_symbol: "9,LIQSOLP",
        initial_chain_amount: "1000000000",
        initial_wire_amount: "2000000000000",
        fee: 30,
        locked_shares: "0",
        conversion_horizon_sec: 86_400,
        depth_cap_bps: 50,
        clip_floor: "1000"
      })
    })

    it("totals and summarizes each chain", () => {
      expect(WireLcoImportTool.chainPlans(plan)).toEqual([plan.ethereum, plan.solana])
      expect(WireLcoImportTool.syndicatedTotal(plan.ethereum.syndications)).toBe(
        4_500_000_000n
      )
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
      expect(record.t5DexAllocation).toBe(80_000_000_000_000n + 2_000_000_000_000n)
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

    it("refuses a Solana export read from another program than the external outpost", () => {
      const outposts = (programId: string) => ({
        ...fixtureExternalOutposts(),
        solana: { programId }
      })
      expect(plan.solana.programId).toBe(solanaSnapshot().programId)
      expect(() =>
        WireLcoImportTool.assertExportOutposts(
          plan,
          outposts(plan.solana.programId)
        )
      ).not.toThrow()
      expect(() =>
        WireLcoImportTool.assertExportOutposts(
          plan,
          outposts(SolanaPurchaserAddress)
        )
      ).toThrow(
        new RegExp(`read from program ${plan.solana.programId}, not the outpost`)
      )
      expect(() =>
        WireLcoImportTool.assertExportOutposts(
          { ...plan, solana: null },
          outposts(SolanaPurchaserAddress)
        )
      ).not.toThrow()
    })

    it("earmarks every pool's WIRE side, as the record's t5DexAllocation", () => {
      expect(WireLcoImportTool.dexEarmark(plan)).toBe(
        plan.ethereum.pool.initialWireAmount + plan.solana.pool.initialWireAmount
      )
      expect(
        WireLcoImportTool.toBootstrapPlatformConfig(plan, "test").t5DexAllocation
      ).toBe(WireLcoImportTool.dexEarmark(plan))
    })

    it("digests every allocation, so equal counts and totals still differ", () => {
      const [first, second] = plan.solana.claims,
        swapped = {
          ...plan,
          solana: {
            ...plan.solana,
            claims: [
              { ...first, wire_atomic: second.wire_atomic },
              { ...second, wire_atomic: first.wire_atomic }
            ]
          }
        },
        { digest, ...counts } = WireLcoImportTool.summarize(plan),
        { digest: swappedDigest, ...swappedCounts } =
          WireLcoImportTool.summarize(swapped)
      expect(swappedCounts).toEqual(counts)
      expect(swappedDigest).not.toBe(digest)
      expect(digest).toBe(WireLcoImportTool.planDigest(plan))
      expect(digest).toMatch(/^[a-f0-9]{64}$/)
    })

    it("hashes a Solana export as capital-index does, over its own key order", () => {
      const exported = solanaSnapshot()
      expect(
        WireLcoImportTool.solanaAllocationHash(JSON.stringify(exported, null, 2))
      ).toBe(exported.allocationHash)
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
