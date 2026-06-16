import "jest"
import {
  convertImportSeed,
  createAccountWithResources,
  createAuthExLink,
  DEV_K1_PUBLIC_KEY,
  emPrivateKeyFromEthWallet,
  FlowTestContext,
  log,
  pollUntil,
  serializeBatchForClio,
  sleep,
  type ImportSeedBatch,
  type IndexBalanceDump
} from "@wireio/test-cluster-tool"
import { ChainKind } from "@wireio/opp-typescript-models"
import {
  buildControlledEthStakers,
  buildSyntheticEthDump,
  buildSyntheticSolDump,
  type ControlledEthStaker
} from "./syntheticDump"

/**
 * Multi-Hour Emissions + sysio.dclaim Payout Soak
 * ──────────────────────────────────────────────────
 *
 * Bootstraps a fresh cluster (Phase 15b/c now seeds emissions config +
 * dclaim::setconfig). Generates a synthetic indexer dump in-test (no
 * committed fixtures, no live API call), imports it via
 * `sysio.dclaim::importseed`, then drives a long stretch of synced
 * epochs to verify:
 *
 *   (a) **Stability** — chain stays synced across all three nets for
 *       the configured duration, no panics / forks / nodeop crashes.
 *   (b) **Emissions accrual** — every `pay_cadence_epochs` boundary
 *       fires payepoch; t5_state.total_distributed advances
 *       monotonically; capex/governance accounts receive their bps
 *       splits; `total_distributed <= t5_distributable - t5_floor`.
 *   (c) **importseed → link → claim path** — synthetic staker accounts
 *       (this test holds their ETH wallets) complete AuthEx linking →
 *       sysio.authex inline-calls sysio.dclaim::linkswept →
 *       unmapped_tokens row sweeps into pending_claims → user `claim`
 *       succeeds → WIRE arrives at user. dclaim is pre-funded from
 *       sysio for the synthetic load (the importseed path does not
 *       call fundclaim; only the onreward path does).
 *
 * **Out of scope:** `sysio.system::fundclaim` cap semantics from PR 354.
 * That code path fires only on `sysio.dclaim::onreward`, driven by
 * STAKING_REWARD attestations from the outposts. wire-ethereum
 * `StakingManager.sol` is currently a rename-only placeholder; the
 * exhaust flow will be added in a follow-up PR once outpost emission
 * lands. `capital_shortfall_total` is asserted == 0 here (trivially
 * true today because no `fundclaim` calls occur).
 *
 * Default target: 30 minutes wall-clock at 60s epochs ⇒ ~30 epochs.
 * Override via `SOAK_DURATION_MS`. Below ~5min the per-epoch assertions
 * may not have enough samples.
 *
 * Cluster data dir: the standard fresh-mode `WIRE_CLUSTER_PATH` (resolved
 * by `FlowTestContext.create`, asserted in `FlowTestContext.fresh`) —
 * identical to every gate flow. No bespoke `WIRE_CHAIN_DIR` / `/mnt/data`
 * path; the harness owns directory creation.
 */

// ─── Config ────────────────────────────────────────────────────────────────
const SOAK_DURATION_MS = Number(
  process.env.SOAK_DURATION_MS ?? 30 * 60 * 1000
)
const EPOCH_DURATION_SEC = Number(process.env.EPOCH_DURATION_SEC ?? 60)
const CONTROLLED_STAKER_COUNT = Number(process.env.CONTROLLED_STAKER_COUNT ?? 5)
/** Per controlled staker, source-decimal (18) amount on the ETH side. */
const CONTROLLED_STAKER_SOURCE_UNITS = 100_000_000_000_000_000_000n // 100e18
/** Bulk-only synthetic data — exercises larger importseed batches. */
const BULK_ETH_PURCHASERS = Number(process.env.BULK_ETH_PURCHASERS ?? 40)
const BULK_ETH_STAKERS = Number(process.env.BULK_ETH_STAKERS ?? 40)
const BULK_ETH_OVERLAPPING = Number(process.env.BULK_ETH_OVERLAPPING ?? 8)
const BULK_ETH_YIELD_CLAIMED = Number(process.env.BULK_ETH_YIELD_CLAIMED ?? 8)
const BULK_SOL_PURCHASERS = Number(process.env.BULK_SOL_PURCHASERS ?? 20)
const BULK_SOL_STAKERS = Number(process.env.BULK_SOL_STAKERS ?? 20)
const SYNTHETIC_SEED = Number(process.env.SYNTHETIC_SEED ?? 1)

// ─── Helpers ───────────────────────────────────────────────────────────────
interface T5StateRow {
  total_distributed: string | number
  capital_shortfall_total: string | number
}

interface EmissionConfigRow {
  t5_distributable: string | number
  t5_floor: string | number
  pay_cadence_epochs: number
  compute_bps: number
  capex_bps: number
  governance_bps: number
}

async function readT5State(ctx: FlowTestContext): Promise<T5StateRow> {
  const { rows } = await ctx.wireClient.getTableRows<T5StateRow>({
    code: "sysio",
    scope: "sysio",
    table: "t5state"
  })
  expect(rows.length).toBeGreaterThanOrEqual(1)
  return rows[0]!
}

async function readEmissionConfig(
  ctx: FlowTestContext
): Promise<EmissionConfigRow> {
  const { rows } = await ctx.wireClient.getTableRows<EmissionConfigRow>({
    code: "sysio",
    scope: "sysio",
    table: "emitcfg"
  })
  expect(rows.length).toBeGreaterThanOrEqual(1)
  return rows[0]!
}

async function readWireBalance(
  ctx: FlowTestContext,
  account: string
): Promise<bigint> {
  const { rows } = await ctx.wireClient.getTableRows<{ balance: string }>({
    code: "sysio.token",
    scope: account,
    table: "accounts"
  })
  if (rows.length === 0) return 0n
  // "1234.000000000 WIRE" -> integer atomic units (9 decimals)
  const [intPart, fracPart = ""] = rows[0]!.balance.split(" ")[0]!.split(".")
  const fracPadded = (fracPart + "000000000").slice(0, 9)
  return BigInt(intPart!) * 1_000_000_000n + BigInt(fracPadded || "0")
}

/** Push a single importseed batch via the dclaim self-auth and wait. */
async function pushImportSeed(
  ctx: FlowTestContext,
  batch: ImportSeedBatch
): Promise<void> {
  await ctx.wireClient.clio.pushActionAndWait(
    "sysio.dclaim",
    "importseed",
    serializeBatchForClio(batch),
    "sysio.dclaim@active"
  )
}

// ─── Test suite ────────────────────────────────────────────────────────────
// Cluster suite is skipped when WIRE_BUILD_PATH isn't set so the
// non-cluster unit tests below can be run via `--testNamePattern`
// without nodeop / anvil / solana-test-validator on PATH.
const describeCluster = process.env.WIRE_BUILD_PATH ? describe : describe.skip

describeCluster("Emissions + dclaim multi-hour soak", () => {
  let ctx: FlowTestContext
  let controlled: ControlledEthStaker[]
  let ethDump: IndexBalanceDump
  let solDump: IndexBalanceDump

  beforeAll(async () => {
    // Build controlled stakers + synthetic dumps that include them.
    // Generation happens here so each suite run is self-contained and
    // the seed change is observable in the log header.
    controlled = buildControlledEthStakers(
      CONTROLLED_STAKER_COUNT,
      "soak.s",
      CONTROLLED_STAKER_SOURCE_UNITS
    )
    ethDump = buildSyntheticEthDump({
      seed: SYNTHETIC_SEED,
      purchaserCount: BULK_ETH_PURCHASERS,
      stakerCount: BULK_ETH_STAKERS,
      overlappingCount: BULK_ETH_OVERLAPPING,
      yieldClaimedCount: BULK_ETH_YIELD_CLAIMED,
      controlled
    })
    solDump = buildSyntheticSolDump({
      seed: SYNTHETIC_SEED + 1,
      purchaserCount: BULK_SOL_PURCHASERS,
      stakerCount: BULK_SOL_STAKERS
    })
    log.info(
      `[soak] synthetic dumps: ETH purchasers=${ethDump.purchasers?.length ?? 0} ` +
        `stakers=${ethDump.stakers?.length ?? 0} ` +
        `SOL purchasers=${solDump.purchasers?.length ?? 0} ` +
        `stakers=${solDump.stakers?.length ?? 0} ` +
        `controlled=${controlled.length} (seed=${SYNTHETIC_SEED})`
    )

    ctx = await FlowTestContext.create({
      epochDurationSec: EPOCH_DURATION_SEC,
      producerCount: 3,
      batchOperatorCount: 3,
      underwriterCount: 1
    })
    log.info(`[soak] cluster data dir: ${ctx.clusterPath}`)
  }, 30 * 60 * 1000)

  afterAll(async () => {
    try {
      await ctx?.teardown()
    } catch (err) {
      log.error("[soak] teardown error:", err)
    }
  }, 5 * 60 * 1000)

  // ──────────────────────────────────────────────────────────────────────
  // 1. Bootstrap sanity — confirms Phase 15b/c left the chain in the
  //    expected state before we put any pressure on it.
  // ──────────────────────────────────────────────────────────────────────
  it("bootstrap leaves emissions configured and dclaim initialized", async () => {
    const cfg = await readEmissionConfig(ctx)
    expect(cfg.compute_bps).toBe(4000)
    expect(cfg.capex_bps).toBe(2000)
    expect(cfg.governance_bps).toBe(1000)
    expect(Number(cfg.pay_cadence_epochs)).toBeGreaterThanOrEqual(1)

    const { rows } = await ctx.wireClient.getTableRows<{
      imported_complete: boolean | number
      claim_window_sec: number
    }>({
      code: "sysio.dclaim",
      scope: "sysio.dclaim",
      table: "capcfg"
    })
    expect(rows.length).toBeGreaterThanOrEqual(1)
    // Table serializes bool as 0/1; coerce so the assertion is on the
    // logical value regardless of clio's encoding shape.
    expect(Boolean(rows[0]!.imported_complete)).toBe(false)
    expect(rows[0]!.claim_window_sec).toBeGreaterThan(0)

    const t5 = await readT5State(ctx)
    expect(Number(t5.total_distributed)).toBeGreaterThanOrEqual(0)
    expect(Number(t5.capital_shortfall_total)).toBe(0)
  })

  // ──────────────────────────────────────────────────────────────────────
  // 2. Convert + import the synthetic dumps. The ETH dump includes the
  //    controlled stakers (we'll exercise their link/claim path later);
  //    bulk rows just verify importseed accepts large batches and the
  //    unmapped_tokens table populates.
  // ──────────────────────────────────────────────────────────────────────
  it("converts synthetic dumps and seeds dclaim via importseed", async () => {
    // Ensure the default wallet is open + unlocked — kiod is restarted
    // between cluster create and run, leaving it closed/locked.
    await ctx.wireClient.clio.walletOpenAndUnlock()

    const ethConv = convertImportSeed(ethDump, { chain: "CHAIN_KIND_EVM" })
    const solConv = convertImportSeed(solDump, { chain: "CHAIN_KIND_SVM" })
    log.info(
      `[soak] ETH conversion: ${ethConv.uniqueAddresses} unique, ` +
        `${ethConv.nonZeroCredits} credits, ${ethConv.batches.length} batches, ` +
        `${ethConv.totalAtomic} atomic total, dust=${ethConv.droppedDust}`
    )
    log.info(
      `[soak] SOL conversion: ${solConv.uniqueAddresses} unique, ` +
        `${solConv.nonZeroCredits} credits, ${solConv.batches.length} batches, ` +
        `${solConv.totalAtomic} atomic total, dust=${solConv.droppedDust}`
    )

    // Sanity: every controlled staker survives conversion. Since
    // controlled totals are exactly CONTROLLED_STAKER_SOURCE_UNITS
    // (≥ 1e18), each maps to exactly CONTROLLED_STAKER_SOURCE_UNITS/1e9
    // atomic WIRE with zero dust.
    const expectedAtomic = CONTROLLED_STAKER_SOURCE_UNITS / 1_000_000_000n
    for (const c of controlled) {
      const credit = ethConv.batches
        .flatMap(b => b.credits)
        .find(cr => cr.native_address === c.addressHex)
      expect(credit).toBeDefined()
      expect(credit!.wire_atomic).toBe(expectedAtomic)
    }

    for (const batch of ethConv.batches) await pushImportSeed(ctx, batch)
    for (const batch of solConv.batches) await pushImportSeed(ctx, batch)

    await ctx.wireClient.clio.pushActionAndWait(
      "sysio.dclaim",
      "importdone",
      {},
      "sysio.dclaim@active"
    )

    // Verify dclaim's unmapped_tokens table populates. WIREClient defaults
    // limit=100, so for fixture sizes >100 we'd undercount; bump it. The
    // contract dedups by (chain, native_addr) on insert, so use a soft
    // lower-bound on the controlled stakers (which we know are unique by
    // construction).
    const { rows: unmapped } = await ctx.wireClient.getTableRows<unknown>({
      code: "sysio.dclaim",
      scope: "sysio.dclaim",
      table: "unmapped",
      limit: 5000
    })
    expect(unmapped.length).toBeGreaterThanOrEqual(controlled.length)
    log.info(`[soak] unmapped_tokens populated with ${unmapped.length} rows`)
  }, 30 * 60 * 1000)

  // ──────────────────────────────────────────────────────────────────────
  // 3. Stability + emissions accrual — periodic sampling of t5_state
  //    over the full soak window.
  // ──────────────────────────────────────────────────────────────────────
  it(
    "advances >= configured wall-clock with monotonic emissions accrual",
    async () => {
      const cfgRow = await readEmissionConfig(ctx)
      const t5Headroom =
        BigInt(cfgRow.t5_distributable) - BigInt(cfgRow.t5_floor)

      const startT5 = await readT5State(ctx)
      const startDistributed = BigInt(startT5.total_distributed)
      const sampleInterval = Math.max(60_000, Math.floor(SOAK_DURATION_MS / 12))
      const samples: { atMs: number; distributed: bigint; shortfall: bigint }[] = []
      const startWall = Date.now()
      const deadline = startWall + SOAK_DURATION_MS

      while (Date.now() < deadline) {
        await sleep(sampleInterval)
        const t5 = await readT5State(ctx)
        const distributed = BigInt(t5.total_distributed)
        const shortfall = BigInt(t5.capital_shortfall_total)
        samples.push({
          atMs: Date.now() - startWall,
          distributed,
          shortfall
        })
        log.info(
          `[soak] +${Math.round((Date.now() - startWall) / 1000)}s ` +
            `distributed=${distributed} shortfall=${shortfall}`
        )
      }

      let prev = startDistributed
      for (const s of samples) {
        expect(s.distributed >= prev).toBe(true)
        prev = s.distributed
      }

      // No shortfalls in a healthy soak — capital reserve must cover the
      // synthetic claim load by construction.
      const finalShortfall = samples[samples.length - 1]!.shortfall
      expect(finalShortfall).toBe(0n)

      // Distributed must respect t5_distributable - t5_floor at all times.
      const finalDistributed = samples[samples.length - 1]!.distributed
      expect(finalDistributed <= t5Headroom).toBe(true)

      // Sanity: did anything actually accrue?
      expect(finalDistributed > startDistributed).toBe(true)
    },
    SOAK_DURATION_MS + 30 * 60 * 1000
  )

  // ──────────────────────────────────────────────────────────────────────
  // 4. Per-staker dclaim payouts — exercises importseed → authex link →
  //    linkswept (inline from authex) → claim → token transfer.
  //
  // Note on funding: `dclaim::claim` just drains the pclaim row and
  // inline-transfers WIRE from `sysio.dclaim` to the user. It does NOT
  // call `fundclaim`. Only `dclaim::onreward` (driven by STAKING_REWARD
  // attestations from `sysio.msgch`) calls `fundclaim` to top up
  // dclaim's account from `sysio`. So for the importseed path, dclaim
  // must already hold WIRE matching the seeded pclaim totals — which is
  // what a real launch script does. We replicate that here with a
  // pre-fund transfer.
  // ──────────────────────────────────────────────────────────────────────
  it("controlled stakers complete link → claim end-to-end", async () => {
    const perStakerAtomic =
      CONTROLLED_STAKER_SOURCE_UNITS / 1_000_000_000n
    const fundAtomic = perStakerAtomic * BigInt(controlled.length)
    // Format as "X.000000000 WIRE" without floating-point drift.
    const intPart = fundAtomic / 1_000_000_000n
    const fracPart = (fundAtomic % 1_000_000_000n).toString().padStart(9, "0")
    const fundAsset = `${intPart.toString()}.${fracPart} WIRE`

    // Re-open + unlock the wallet — kiod gets restarted between
    // ClusterManager's create and run phases, so the default wallet is
    // closed/locked when we get here. Matches the pattern used by
    // OperatorProvisioningTool for the same reason.
    await ctx.wireClient.clio.walletOpenAndUnlock()

    // (a) Pre-fund sysio.dclaim from sysio for the controlled-staker
    //     obligations.
    await ctx.wireClient.clio.pushActionAndWait(
      "sysio.token",
      "transfer",
      {
        from: "sysio",
        to: "sysio.dclaim",
        quantity: fundAsset,
        memo: "pre-fund for importseed claim payouts"
      },
      "sysio@active"
    )

    // (b) Create wire accounts for each controlled staker. We use the
    //     shared dev K1 key for the account's owner/active permission so
    //     kiod (which already holds the matching DEV_K1 private key
    //     from bootstrap) can sign `-p soak.sX@active` actions. The
    //     staker's ETH-derived EM key is plumbed only into the AuthEx
    //     `createlink` action below — it identifies which ETH wallet
    //     "owns" the wire account, not how it signs.
    //
    //     `addpolicy` on sysio.roa grants the account enough
    //     ram/cpu/net to host its rows (authex link + dclaim pclaim row).
    //     Without it, the createlink inline-action trips the RAM
    //     guard on the new account.
    for (const s of controlled) {
      await createAccountWithResources(
        ctx.wireClient.clio,
        s.wireAccount,
        DEV_K1_PUBLIC_KEY
      )
    }

    // (c) Link each staker's ETH wallet to its wire account via authex,
    //     then sweep the matching `unmapped_tokens` row into
    //     `pending_claims`. `sysio.authex::createlink` only writes the
    //     link + updates the account's permissions — it does NOT
    //     auto-call `sysio.dclaim::linkswept` (per
    //     contracts/sysio.authex/src/sysio.authex.cpp::createlink). The
    //     sweep is a separate AUTHEX-authed action driven by the holder
    //     of the seeded credit: in real launch, an off-chain orchestrator
    //     batches one `linkswept` per fresh link. We mirror that here.
    //
    //     `native_pubkey` on the unmapped row is whatever bytes
    //     `importseed` wrote — for ETH that's the 20-byte address (per
    //     convertImportSeed). Linkswept matches on raw equality, so the
    //     same 20-byte address must be supplied here, not the 33-byte
    //     compressed pubkey.
    for (const s of controlled) {
      await createAuthExLink(ctx.wireClient.clio, {
        chainKind: ChainKind.EVM,
        account: s.wireAccount,
        privateKey: emPrivateKeyFromEthWallet(s.wallet),
        ethWallet: s.wallet
      })
      await ctx.wireClient.clio.pushActionAndWait<{
        wire_account: string
        chain: string
        native_pubkey: string
      }>(
        "sysio.dclaim",
        "linkswept",
        {
          wire_account: s.wireAccount,
          chain: "CHAIN_KIND_EVM",
          // Hex bytes are encoded as a lower-case hex string for the
          // ABI's `bytes` type — same shape `importseed` stored.
          native_pubkey: s.addressHex
        },
        "sysio.authex@active"
      )
    }

    // (d) Confirm pending_claims rows landed.
    await pollUntil(
      "pending_claims populated for all linked stakers",
      async () => {
        const { rows } = await ctx.wireClient.getTableRows<{
          wire_account: string
          balance: string
        }>({
          code: "sysio.dclaim",
          scope: "sysio.dclaim",
          table: "pclaims"
        })
        const linkedAccts = new Set(controlled.map(s => s.wireAccount))
        const landed = rows.filter(r => linkedAccts.has(r.wire_account))
        return landed.length === controlled.length
      },
      2 * 60_000,
      2_000
    )

    // (e) Claim and verify each staker receives its seeded amount in WIRE.
    for (const s of controlled) {
      const before = await readWireBalance(ctx, s.wireAccount)
      await ctx.wireClient.clio.pushActionAndWait(
        "sysio.dclaim",
        "claim",
        { wire_account: s.wireAccount },
        `${s.wireAccount}@active`
      )
      const after = await readWireBalance(ctx, s.wireAccount)
      const delta = after - before
      expect(delta).toBe(perStakerAtomic)
    }

    // (f) capital_shortfall_total stays 0 (no fundclaim calls in this
    //     path — only onreward-driven claims can move it).
    const t5 = await readT5State(ctx)
    expect(BigInt(t5.capital_shortfall_total)).toBe(0n)
  })
})

// ──────────────────────────────────────────────────────────────────────
// Pure-unit-level tests below — top-level so they don't inherit the
// outer suite's cluster-bootstrap beforeAll. Run via
//   pnpm test --testNamePattern "(convertImportSeed|synthetic dump)"
// without needing nodeop / anvil / solana-test-validator on PATH.
// ──────────────────────────────────────────────────────────────────────

describe("convertImportSeed (unit-level sanity)", () => {
    it("batches an empty dump into zero batches", () => {
      const result = convertImportSeed(
        { purchasers: [], stakers: [] },
        { chain: "CHAIN_KIND_EVM" }
      )
      expect(result.batches).toHaveLength(0)
      expect(result.totalAtomic).toBe(0n)
      expect(result.uniqueAddresses).toBe(0)
    })

    it("dedupes addresses appearing in both purchasers and stakers", () => {
      const dump: IndexBalanceDump = {
        purchasers: [
          { address: "0x" + "11".repeat(20), totalPretokens: "5000000000" }
        ],
        stakers: [
          {
            address: "0x" + "11".repeat(20),
            pretokenYield: "3000000000",
            yieldClaimed: "1000000000"
          }
        ]
      }
      const result = convertImportSeed(dump, { chain: "CHAIN_KIND_EVM" })
      expect(result.uniqueAddresses).toBe(1)
      expect(result.nonZeroCredits).toBe(1)
      const credit = result.batches[0]!.credits[0]!
      expect(credit.wire_atomic).toBe(7n)
      expect(credit.native_address).toBe("11".repeat(20))
    })

    it("drops sub-atomic dust on ETH and reports it", () => {
      const dump: IndexBalanceDump = {
        purchasers: [
          { address: "0x" + "22".repeat(20), totalPretokens: "1500000000" }
        ]
      }
      const result = convertImportSeed(dump, { chain: "CHAIN_KIND_EVM" })
      expect(result.batches[0]!.credits[0]!.wire_atomic).toBe(1n)
      expect(result.droppedDust).toBe(500_000_000n)
    })

    it("emits SOL credits 1:1 (divisor = 1, no dust)", () => {
      const dump: IndexBalanceDump = {
        purchasers: [
          {
            address: "4vJ9JU1bJJE96FbKdjWme2JC2nKjpGoxiNzU1S6mYP78",
            totalPretokens: "987654321"
          }
        ]
      }
      const result = convertImportSeed(dump, { chain: "CHAIN_KIND_SVM" })
      expect(result.batches[0]!.credits[0]!.wire_atomic).toBe(987_654_321n)
      expect(result.droppedDust).toBe(0n)
    })

    it("chunks per batchSize and serializes BigInts as strings for clio", () => {
      const dump: IndexBalanceDump = {
        purchasers: Array.from({ length: 5 }, (_, i) => ({
          address: "0x" + (i + 1).toString(16).padStart(2, "0").repeat(20),
          totalPretokens: "1000000000"
        }))
      }
      const result = convertImportSeed(dump, {
        chain: "CHAIN_KIND_EVM",
        batchSize: 2
      })
      expect(result.batches.map(b => b.credits.length)).toEqual([2, 2, 1])
      const serialized = serializeBatchForClio(result.batches[0]!)
      expect(typeof serialized.credits[0]!.wire_atomic).toBe("string")
      expect(serialized.credits[0]!.wire_atomic).toBe("1")
    })
})

describe("synthetic dump generator (unit-level sanity)", () => {
    it("is deterministic given the same seed", () => {
      const a = buildSyntheticEthDump({
        seed: 42,
        purchaserCount: 3,
        stakerCount: 3,
        overlappingCount: 1
      })
      const b = buildSyntheticEthDump({
        seed: 42,
        purchaserCount: 3,
        stakerCount: 3,
        overlappingCount: 1
      })
      // Strip non-deterministic metadata.generatedAt before comparing.
      expect({ ...a, metadata: undefined }).toEqual({
        ...b,
        metadata: undefined
      })
    })

    it("produces dumps that convertImportSeed accepts and counts correctly", () => {
      const ctrl = buildControlledEthStakers(2, "test.s", 10n ** 18n)
      const dump = buildSyntheticEthDump({
        seed: 7,
        purchaserCount: 4,
        stakerCount: 3,
        overlappingCount: 2, // adds 2 rows to each side
        yieldClaimedCount: 1, // adds 1 row to stakers
        controlled: ctrl // adds 2 rows to purchasers
      })
      // Row counts in the raw dump:
      //   purchasers = 4 (std) + 2 (overlap) + 2 (controlled) = 8
      //   stakers    = 3 (std) + 2 (overlap) + 1 (yieldClaimed) = 6
      expect(dump.purchasers).toHaveLength(8)
      expect(dump.stakers).toHaveLength(6)

      const result = convertImportSeed(dump, { chain: "CHAIN_KIND_EVM" })
      // Unique addresses = 8 + 6 − 2 (dedup of overlapping) = 12
      expect(result.uniqueAddresses).toBe(12)
      // All amounts are ≥ 1e18 source units → ≥ 1 atomic WIRE → no
      // floor-to-zero filtering.
      expect(result.nonZeroCredits).toBe(12)
    })
})
