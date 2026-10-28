import Assert from "node:assert"
import ChildProcess from "node:child_process"
import Fs from "node:fs/promises"
import Path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { stripVTControlCharacters } from "node:util"

import { match, P } from "ts-pattern"

import { API, Asset, SysioContracts } from "@wireio/sdk-core"
import {
  assetUnits,
  scaleTimeoutMs,
  ClusterBuildPhase,
  ClusterBuildStep,
  FlowScenario,
  LogFileAppender,
  ProtocolTiming,
  Report,
  Steps,
  StepExtraRecorder,
  WireClient,
  outputKey,
  pollUntil,
  verifyStep,
  type ClusterBuild,
  type ClusterBuildContext,
  type ClusterBuildOptions,
  type ClusterBuildStepOptions,
  type StepInput
} from "@wireio/cluster-tool"
import { Deferred, getLogger, isString, Level } from "@wireio/shared"
import { LIQKickerAccrual } from "./LIQKickerAccrual.js"
import { LIQKickerScenarioConstants as Constants } from "./LIQKickerScenarioConstants.js"

const { SysioContractName } = SysioContracts
const { Actor } = Report
const log = getLogger(__filename)

// ── reads (execute freely inside runners and verify steps) ──────────────────

/** The one-row range of a symbol-keyed KV table for `code`. */
function symbolRange(code: string): WireClient.TableQueryArgs {
  return {
    ...WireClient.symbolCodeKeyRange(Constants.SymbolKeyField, code),
    limit: 1
  }
}

/** `sysio.kicker::kickcfg` — the budget, minimum interval and observation window (a read). */
async function readKickerConfig(
  ctx: ClusterBuildContext
): Promise<SysioContracts.SysioKickerKickConfigType> {
  const { rows } = await ctx.wire
    .getSysioContract(SysioContractName.kicker)
    .tables.kickcfg.query({ limit: 1 })
  Assert.ok(
    rows.length === 1,
    "sysio.kicker::kickcfg has no row — the bootstrap's Kicker phase never configured it"
  )
  return rows[0]
}

/** The flow token's `sysio.kicker::kickpools` row (a read). */
async function readKickerPool(
  ctx: ClusterBuildContext
): Promise<SysioContracts.SysioKickerKickPoolType> {
  const { rows } = await ctx.wire
    .getSysioContract(SysioContractName.kicker)
    .tables.kickpools.query(symbolRange(Constants.LIQTokenCodename))
  Assert.ok(
    rows.length === 1,
    `sysio.kicker::kickpools has no ${Constants.LIQTokenCodename} row — did the bootstrap's KickerPools phase run?`
  )
  return rows[0]
}

/** The flow token's shadow supply on `sysio.liq` (base units). */
async function readShadowSupply(ctx: ClusterBuildContext): Promise<bigint> {
  const { rows } = await ctx.wire
    .getSysioContract(SysioContractName.liq)
    .tables.stat.query(symbolRange(Constants.LIQTokenCodename))
  Assert.ok(
    rows.length === 1,
    `sysio.liq::stat has no ${Constants.LIQTokenCodename} row`
  )
  return assetUnits(rows[0].supply)
}

/** A LIQ/WIRE pair's two reserves (base units). */
interface PairReserves {
  /** The shadow reserve (`pool1`). */
  readonly poolShadow: bigint
  /** The WIRE reserve (`pool2`). */
  readonly poolWire: bigint
}

/** The flow token's LIQ/WIRE pair reserves on `sysio.swap` — the current spot used only to extend the cumulative-price accumulator. */
async function readPairReserves(
  ctx: ClusterBuildContext
): Promise<PairReserves> {
  const { rows } = await ctx.wire
    .getSysioContract(SysioContractName.swap)
    .tables.stat.query(symbolRange(Constants.PairTokenCodename))
  Assert.ok(
    rows.length === 1,
    `sysio.swap::stat has no ${Constants.PairTokenCodename} pair`
  )
  const [pair] = rows
  return {
    poolShadow: assetUnits(String(pair.pool1.quantity)),
    poolWire: assetUnits(String(pair.pool2.quantity))
  }
}

/**
 * The flow token's `sysio.liq::yieldidx` row. Absent until the first distribution,
 * when the contract computes against a value-initialized index (all zero).
 */
async function readYieldIndex(
  ctx: ClusterBuildContext
): Promise<SysioContracts.SysioLiqYieldIndexType> {
  const { rows } = await ctx.wire
    .getSysioContract(SysioContractName.liq)
    .tables.yieldidx.query(symbolRange(Constants.LIQTokenCodename))
  return rows.length === 0 ? { index: "0", pot: 0, carry: 0 } : rows[0]
}

/**
 * The treasury's, the two category buckets' and the kicker's WIRE, read until two
 * consecutive reads agree. `payepoch` moves WIRE from the treasury to the buckets
 * at every epoch advance; a read that straddled one would count that transfer
 * twice or not at all, and two identical consecutive reads cannot straddle one.
 */
export async function readWireHoldings(
  ctx: ClusterBuildContext,
  signal: AbortSignal
): Promise<KickerWireHoldings> {
  signal.throwIfAborted()
  const controller = new AbortController(),
    bounded = AbortSignal.any([signal, controller.signal]),
    timer = setTimeout(
      () =>
        controller.abort(
          new Error("WIRE holdings did not stabilize before the deadline")
        ),
      scaleTimeoutMs(Constants.SnapshotTimeoutMs)
    )
  try {
    const read = async (): Promise<KickerWireHoldings> => {
        const [treasury, ...buckets] = await Promise.all(
          [Constants.TreasuryAccount, ...Constants.CategoryBucketAccounts].map(
            account => ctx.wire.getWireBalance(account)
          )
        )
        return {
          treasury,
          categoryBuckets: buckets.reduce((sum, balance) => sum + balance, 0n),
          kicker: await ctx.wire.getWireBalance(Constants.KickerAccount)
        }
      },
      same = (left: KickerWireHoldings, right: KickerWireHoldings): boolean =>
        left.treasury === right.treasury &&
        left.categoryBuckets === right.categoryBuckets &&
        left.kicker === right.kicker
    let previous = await cancellable(read(), bounded)
    for (;;) {
      bounded.throwIfAborted()
      const current = await cancellable(read(), bounded)
      if (same(previous, current)) return current
      previous = current
      await delay(Constants.PollIntervalMs, null, { signal: bounded })
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Await a read with cancellation; remove its listener on every completion path. */
async function cancellable<T>(
  work: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  signal.throwIfAborted()
  const aborted = new Deferred<T>(),
    onAbort = () => aborted.reject(signal.reason)
  signal.addEventListener("abort", onAbort, { once: true })
  try {
    return await Promise.race([work, aborted.promise])
  } finally {
    signal.removeEventListener("abort", onAbort)
  }
}

/** WIRE balances the treasury check reads (base units). */
export interface KickerWireHoldings {
  /** `sysio`'s WIRE — the treasury the gift is drawn from. */
  readonly treasury: bigint
  /** `sysio.ops` + `sysio.gov` — where an epoch advance moves treasury WIRE. */
  readonly categoryBuckets: bigint
  /** `sysio.kicker`'s WIRE — the gift only passes through it. */
  readonly kicker: bigint
}

/** Everything one kick reads or writes, captured at one point of the flow. */
export interface KickerSnapshot {
  readonly config: SysioContracts.SysioKickerKickConfigType
  readonly pool: SysioContracts.SysioKickerKickPoolType
  /** The token's shadow supply (base units). */
  readonly supply: bigint
  /** The LIQ/WIRE pair's shadow reserve (base units). */
  readonly poolShadow: bigint
  /** The LIQ/WIRE pair's WIRE reserve (base units). */
  readonly poolWire: bigint
  readonly yieldIndex: SysioContracts.SysioLiqYieldIndexType
  readonly holdings: KickerWireHoldings
}

/** Read a {@link KickerSnapshot}. */
async function readSnapshot(
  ctx: ClusterBuildContext,
  signal: AbortSignal
): Promise<KickerSnapshot> {
  const [config, pool, supply, reserves, yieldIndex, holdings] =
    await Promise.all([
      readKickerConfig(ctx),
      readKickerPool(ctx),
      readShadowSupply(ctx),
      readPairReserves(ctx),
      readYieldIndex(ctx),
      readWireHoldings(ctx, signal)
    ])
  return { config, pool, supply, ...reserves, yieldIndex, holdings }
}

/** `last_kick` in microseconds since the epoch (`time_point` JSON has millisecond precision). */
function lastKickMicros(pool: SysioContracts.SysioKickerKickPoolType): bigint {
  return (
    BigInt(WireClient.chainTimeMs(pool.last_kick)) *
    Constants.MicrosPerMillisecond
  )
}

/**
 * The gift the pool pays for `[before.last_kick, after.last_kick]`, priced at the
 * supply and observed cumulative-price delta between the contract snapshots. Asserts they agree: `kick` reads
 * them at its own block, so a change between the snapshots would make the model's
 * inputs ambiguous.
 */
function expectedGift(before: KickerSnapshot, after: KickerSnapshot): bigint {
  Assert.strictEqual(
    BigInt(after.pool.supply_snapshot),
    after.supply,
    "full payment did not checkpoint current supply"
  )
  Assert.strictEqual(
    after.supply,
    before.supply,
    "the shadow supply moved across the kick"
  )
  return LIQKickerAccrual.gift({
    supply: before.supply,
    supplySnapshot: BigInt(before.pool.supply_snapshot),
    rateBps: BigInt(before.pool.rate_bps),
    elapsedMicros: lastKickMicros(after.pool) - lastKickMicros(before.pool),
    price: paidTwap(before, after)
  })
}

/**
 * The Q64.64 TWAP a paid kick priced its gift at: the cumulative-price delta between
 * the contract's observation snapshots over their elapsed microseconds.
 */
function paidTwap(before: KickerSnapshot, after: KickerSnapshot): bigint {
  return LIQKickerAccrual.twap(
    LIQKickerAccrual.cumulative(before.pool.price_snapshot),
    LIQKickerAccrual.cumulative(after.pool.price_snapshot),
    BigInt(
      WireClient.chainTimeMs(after.pool.price_time) -
        WireClient.chainTimeMs(before.pool.price_time)
    ) * Constants.MicrosPerMillisecond
  )
}

/**
 * Assert a paid kick passed the spot guard: the row's `spot_deviation` is clear and the
 * pair's spot at the kick lies within `kickcfg.max_spot_deviation_bps` of the TWAP it paid at.
 */
function assertSpotWithinGuard(
  before: KickerSnapshot,
  after: KickerSnapshot
): void {
  Assert.strictEqual(
    after.pool.spot_deviation,
    false,
    "the paid kick flagged a spot deviation"
  )
  Assert.ok(
    !LIQKickerAccrual.spotDeviates(
      LIQKickerAccrual.priceFixedPoint(before.poolWire, before.poolShadow),
      paidTwap(before, after),
      BigInt(before.config.max_spot_deviation_bps)
    ),
    "the pair's spot strays past the kicker's spot guard from the TWAP it paid at"
  )
}

/**
 * Swap's cumulative price extended to the kick block at the pair's spot, as the
 * contract's `current_price` reads it — the snapshot a payment settles the pool to.
 * @param before - Reserves at the kick.
 * @param accumulator - Swap's pre-mutation price accumulator, not later than the kick.
 * @param blockTime - Confirmed transaction's execution time.
 * @returns The cumulative price at the block, modulo 2^256.
 */
export function cumulativeAtBlock(
  before: KickerSnapshot,
  accumulator: SysioContracts.SysioSwapPriceAccumulatorType,
  blockTime: string
): bigint {
  Assert.ok(accumulator, "swap has no price accumulator")
  Assert.ok(
    WireClient.chainTimeMs(accumulator.last_update) <=
      WireClient.chainTimeMs(blockTime),
    "swap price mutated after the kick; its TWAP cannot be reconstructed"
  )
  return (
    (LIQKickerAccrual.cumulative(accumulator.price1) +
      LIQKickerAccrual.priceFixedPoint(before.poolWire, before.poolShadow) *
        (BigInt(WireClient.chainTimeMs(blockTime)) -
          BigInt(WireClient.chainTimeMs(accumulator.last_update))) *
        Constants.MicrosPerMillisecond) %
    LIQKickerAccrual.CumulativeModulus
  )
}

/**
 * Reconstruct the contract's cumulative-price read at the kick block for a partial payment or skip.
 * @param before - Pool observation baseline, supply and reserves at the kick.
 * @param accumulator - Swap's pre-mutation price accumulator, not later than the kick.
 * @param blockTime - Confirmed transaction's execution time.
 * @returns Supply, unpaid interval and reconstructed TWAP inputs.
 */
function giftInputAtBlock(
  before: KickerSnapshot,
  accumulator: SysioContracts.SysioSwapPriceAccumulatorType,
  blockTime: string,
  clockMicros: bigint = lastKickMicros(before.pool)
): LIQKickerAccrual.GiftInput {
  const now =
      BigInt(WireClient.chainTimeMs(blockTime)) *
      Constants.MicrosPerMillisecond,
    price = LIQKickerAccrual.twap(
      LIQKickerAccrual.cumulative(before.pool.price_snapshot),
      cumulativeAtBlock(before, accumulator, blockTime),
      now -
        BigInt(WireClient.chainTimeMs(before.pool.price_time)) *
          Constants.MicrosPerMillisecond
    )
  return {
    supply: before.supply,
    supplySnapshot: BigInt(before.pool.supply_snapshot),
    rateBps: BigInt(before.pool.rate_bps),
    elapsedMicros: now - clockMicros,
    price
  }
}

/**
 * Reconstruct a gift at its block, sized on the smaller checkpoint/current supply.
 * @param before - State before the kick.
 * @param accumulator - Swap price accumulation through its last update.
 * @param blockTime - Execution block time.
 * @param clockMicros - Exact unpaid clock, including a partial payment's sub-millisecond remainder.
 * @returns The floored gift, bounded to 72 hours of catch-up.
 */
export function expectedGiftAtBlock(
  before: KickerSnapshot,
  accumulator: SysioContracts.SysioSwapPriceAccumulatorType,
  blockTime: string,
  clockMicros: bigint = lastKickMicros(before.pool)
): bigint {
  return LIQKickerAccrual.gift(
    giftInputAtBlock(before, accumulator, blockTime, clockMicros)
  )
}

/**
 * Assert one paid kick moved every ledger by exactly `gift`: the pool's lifetime total
 * and the budget, the shadow's yield index (pot, index and carry), and the treasury —
 * net of any epoch-advance push to the category buckets — while the kicker keeps none.
 */
function assertLedgersMovedBy(
  before: KickerSnapshot,
  after: KickerSnapshot,
  gift: bigint
): void {
  Assert.strictEqual(
    BigInt(after.pool.gifted_total) - BigInt(before.pool.gifted_total),
    gift,
    "kickpools.gifted_total did not grow by the gift"
  )
  Assert.strictEqual(
    BigInt(before.config.budget_remaining) -
      BigInt(after.config.budget_remaining),
    gift,
    "kickcfg.budget_remaining did not fall by the gift"
  )
  Assert.deepStrictEqual(
    {
      index: String(after.yieldIndex.index),
      pot: String(after.yieldIndex.pot),
      carry: String(after.yieldIndex.carry)
    },
    LIQKickerAccrual.distribute(before.yieldIndex, gift, before.supply),
    "sysio.liq::yieldidx is not the index the gift distributes to"
  )
  Assert.strictEqual(
    before.holdings.treasury +
      before.holdings.categoryBuckets -
      (after.holdings.treasury + after.holdings.categoryBuckets),
    gift,
    "the treasury (net of the category buckets) did not fall by the gift"
  )
  Assert.strictEqual(
    after.holdings.kicker,
    before.holdings.kicker,
    "sysio.kicker kept WIRE"
  )
}

// ── the kick transaction ─────────────────────────────────────────────────────

/** The action an action trace executed. */
interface ActionView {
  readonly account: string
  readonly name: string
  readonly data: unknown
}

/** The part of a pushed transaction's action trace the receipt reads. */
interface ActionTraceView {
  readonly receiver?: string
  readonly act?: ActionView
  readonly inline_traces?: ReadonlyArray<ActionTraceView>
}

/** The `sysio.token::transfer` data the treasury draw carries. */
type TransferData = SysioContracts.SysioTokenTransferAction

/** A trace list flattened, whether the node returned it flat or nested. */
function flattenTraces(
  traces: ReadonlyArray<ActionTraceView>
): ActionTraceView[] {
  return traces.flatMap(trace => [
    trace,
    ...flattenTraces(trace.inline_traces ?? [])
  ])
}

/** Kicker gifts must not invoke system emissions accounting or mint fresh WIRE. */
function assertNoEmissionsMutation(
  traces: ReadonlyArray<ActionTraceView>
): void {
  Assert.ok(
    !flattenTraces(traces).some(
      trace =>
        (trace.receiver === Constants.TreasuryAccount &&
          trace.act?.account === Constants.TreasuryAccount) ||
        (trace.receiver === Constants.TokenAccount &&
          trace.act?.account === Constants.TokenAccount &&
          trace.act.name === Constants.IssueActionName)
    ),
    "kick mutated system emissions accounting or issued WIRE"
  )
}

/** What one paid kick's transaction shows. */
export interface KickReceipt {
  /** The treasury draw's `sysio.token::transfer` amount (WIRE base units). */
  readonly paid: bigint
  /** The block time the kick executed at — `current_time_point()` in the contract. */
  readonly blockTime: string
}

/**
 * The receipt of a kick transaction: its single `sysio` → `sysio.kicker` draw (the
 * trace's execution on `sysio.token` itself, not the notifications) and its block
 * time. Fails unless exactly one draw ran, i.e. unless the kick paid.
 *
 * @param response - The pushed transaction's response.
 * @returns The draw and the block time.
 */
export function kickReceipt(
  response: API.v1.SendTransactionResponse
): KickReceipt {
  assertNoEmissionsMutation(
    response.processed.action_traces as ActionTraceView[]
  )
  const draws = flattenTraces(
    response.processed.action_traces as ActionTraceView[]
  )
    .filter(
      trace =>
        trace.receiver === Constants.TokenAccount &&
        trace.act?.account === Constants.TokenAccount &&
        trace.act.name === Constants.TransferActionName
    )
    .map(trace => trace.act.data as TransferData)
    .filter(
      data =>
        data.from === Constants.TreasuryAccount &&
        data.to === Constants.KickerAccount
    )
  Assert.strictEqual(
    draws.length,
    1,
    `the kick transaction drew ${draws.length} times from ${Constants.TreasuryAccount}; a paid kick draws once`
  )
  return {
    paid: assetUnits(draws[0].quantity),
    blockTime: response.processed.block_time
  }
}

/** The `setpool` data for the flow token at `minGift`, keeping the bootstrap's rate and ceiling. */
function setpoolData(minGift: number): SysioContracts.SysioKickerSetpoolAction {
  return {
    sym: Constants.LIQTokenCodename,
    rate_bps: Constants.RateBps,
    min_gift: minGift,
    max_gift_per_day: Constants.MaxGiftPerDay
  }
}

/** Input for {@link LIQKickerScenario.planPayableKick}. */
export interface PayableKickInput extends StepInput {
  readonly kind: "LIQKickerScenario.PayableKickInput"
  /** The governance-signed `setpool` that makes the accrued gift payable. */
  readonly lower: SysioContracts.SysioKickerSetpoolAction
  /** The permissionless kick. */
  readonly kick: SysioContracts.SysioKickerKickAction
  /** The governance-signed `setpool` that restores the bootstrap's minimum. */
  readonly restore: SysioContracts.SysioKickerSetpoolAction
}

// ── the scenario ─────────────────────────────────────────────────────────────

/**
 * LIQ kicker — `sysio.kicker` pays LIQETH holders a WIRE gift for the time since the
 * pool's last payment, drawn from the treasury and distributed through `sysio.liq`'s
 * yield index.
 *
 * 1. **KickerConfigured** — the bootstrap's `setconfig` and LIQETH's `addpool` hold
 *    (`Steps.registry.KickerConfiguration`, 200 bps, a one-WIRE minimum).
 * 2. **ManualKick** — once the minimum interval has passed, one transaction lowers
 *    LIQETH's minimum gift, kicks and restores the minimum. The gift equals the
 *    flow's model of the TWAP-priced accrual over the paid interval; `last_kick` advances to the
 *    kick's block; the yield index, the budget and the treasury move by exactly the
 *    gift.
 * 3. **CrankKick** — only when the cluster's nodeop carries the batch operators' kick
 *    crank: with the minimum lowered and no kick from the flow, a batch operator pays
 *    one unit under a temporary budget and daily cap; its transaction must be
 *    irreversible and its partial clock must agree with the TWAP model.
 */
export class LIQKickerScenario extends FlowScenario {
  readonly name = "flow-liq-kicker"
  readonly description =
    "sysio.kicker pays LIQETH holders the accrued WIRE gift — by a manual kick and, when the nodeop carries it, by the batch operators' crank"

  override readonly defaults: ClusterBuildOptions = {
    // `addpool` needs the token's LIQ/WIRE yield pool, and `regliqpool` is
    // epoch-0-gated by the depot, so the pools (and the kicker pools after them)
    // ride the bootstrap.
    enableMockLiqPools: true,
    epochDurationSec: Constants.EpochDurationSec,
    producerCount: Constants.ProducerCount,
    batchOperatorCount: Constants.BatchOperatorCount,
    underwriterCount: Constants.UnderwriterCount,
    // Crank verification reads full traces, emitted at debug by this logger.
    // Keep the noisy network/consensus loggers at the normal console level.
    logging: { levels: { transactionTraceSuccess: Level.debug } }
  }

  plan(cluster: ClusterBuild): void {
    const depotWriteStepOptions = { timeoutMs: Constants.DepotWriteTimeoutMs },
      crankStepOptions = {
        timeoutMs:
          Constants.CrankPaymentTimeoutMs + ProtocolTiming.PollDeadlineBufferMs
      }

    // ── 1. The bootstrap's kicker configuration ──
    ClusterBuildPhase.create(
      cluster,
      "KickerConfigured",
      "The bootstrap configured the kicker and LIQETH's pool",
      [],
      {
        timeoutMs:
          Constants.SnapshotTimeoutMs + ProtocolTiming.PollDeadlineBufferMs
      }
    ).push(
      verifyStep(
        Actor.Sysio,
        "kicker-configured",
        "kickcfg holds the bootstrap's budget and interval; LIQETH's pool is at 200 bps with the one-WIRE minimum and has paid nothing",
        async (ctx, signal) => {
          signal.throwIfAborted()
          const [config, pool] = await Promise.all([
            readKickerConfig(ctx),
            readKickerPool(ctx)
          ])
          Assert.deepStrictEqual(
            {
              budget_remaining: BigInt(config.budget_remaining),
              min_interval_sec: config.min_interval_sec,
              twap_window_sec: config.twap_window_sec,
              max_spot_deviation_bps: config.max_spot_deviation_bps
            },
            {
              budget_remaining: BigInt(
                Steps.registry.KickerConfiguration.cfg.budget_remaining
              ),
              min_interval_sec:
                Steps.registry.KickerConfiguration.cfg.min_interval_sec,
              twap_window_sec:
                Steps.registry.KickerConfiguration.cfg.twap_window_sec,
              max_spot_deviation_bps:
                Steps.registry.KickerConfiguration.cfg.max_spot_deviation_bps
            }
          )
          Assert.strictEqual(pool.spot_deviation, false)
          Assert.strictEqual(pool.rate_bps, Constants.RateBps)
          Assert.strictEqual(
            BigInt(pool.max_gift_per_day),
            BigInt(Constants.MaxGiftPerDay)
          )
          Assert.strictEqual(pool.price_time, pool.last_kick)
          Assert.ok(
            Steps.registry.KickerPoolRegistrations.length <=
              Constants.CrankPoolsPerPoll,
            "crank fixture no longer fits in one bounded page"
          )
          Assert.strictEqual(
            BigInt(pool.min_gift),
            BigInt(Constants.RestoredMinGift)
          )
          Assert.strictEqual(BigInt(pool.gifted_total), 0n)
        }
      )
    )

    ClusterBuildPhase.create(
      cluster,
      "KickerFlowWindow",
      "Use the minimum governance TWAP window"
    ).push(
      Steps.contracts.sysio.kicker.planSetconfig(
        Actor.Sysio,
        "minimum-twap-window",
        "Set the observation window to 60 seconds",
        depotWriteStepOptions,
        {
          cfg: {
            ...Steps.registry.KickerConfiguration.cfg,
            twap_window_sec: Constants.TwapWindowSec
          }
        }
      )
    )

    LIQKickerScenario.planValidation(cluster)

    // ── 2. A manual kick pays the accrued gift ──
    ClusterBuildPhase.create(
      cluster,
      "ManualKick",
      "Use the matured funding window to kick LIQETH and verify its accrued gift",
      [],
      {
        timeoutMs:
          Constants.SnapshotTimeoutMs + ProtocolTiming.PollDeadlineBufferMs
      }
    ).push(
      verifyStep(
        Actor.Sysio,
        "snapshot-before-kick",
        "record the pool, budget, supply, TWAP snapshot, yield index and treasury before the kick",
        async (ctx, signal) => {
          ctx.outputs.set(
            LIQKickerScenario.BeforeKickKey,
            await readSnapshot(ctx, signal)
          )
        }
      ),
      LIQKickerScenario.planPayableKick(
        Actor.Sysio,
        "kick-liqeth",
        "one transaction: setpool LIQETH to a one-unit minimum, kick(LIQETH), restore the one-WIRE minimum",
        depotWriteStepOptions
      ),
      verifyStep(
        Actor.Sysio,
        "gift-matches-accrual",
        "the paid gift = floor(floor(min(supply_snapshot, supply) × 200 × elapsed_us / (10^4 × 31,557,600 × 10^6)) × TWAP) for the paid interval",
        async (ctx, signal) => {
          signal.throwIfAborted()
          const before = ctx.outputs.assert(LIQKickerScenario.BeforeKickKey),
            receipt = ctx.outputs.assert(LIQKickerScenario.KickReceiptKey),
            after = await readSnapshot(ctx, signal),
            expected = expectedGift(before, after)
          ctx.outputs.set(LIQKickerScenario.AfterKickKey, after)
          log.info(
            `kick(${Constants.LIQTokenCodename}): supply=${before.supply} rate=${before.pool.rate_bps}bps ` +
              `elapsed_us=${lastKickMicros(after.pool) - lastKickMicros(before.pool)} ` +
              `TWAP snapshot=${JSON.stringify(after.pool.price_snapshot)} expected=${expected} paid=${receipt.paid}`
          )
          Assert.ok(
            expected > 0n,
            "the model expects no gift — the paid interval is empty"
          )
          Assert.strictEqual(
            receipt.paid,
            expected,
            "the kick's treasury draw is not the modelled gift"
          )
          Assert.strictEqual(
            BigInt(after.pool.shortfall_amount),
            0n,
            "the kick left a shortfall"
          )
          assertSpotWithinGuard(before, after)
          Assert.strictEqual(
            BigInt(after.pool.min_gift),
            BigInt(Constants.RestoredMinGift),
            "the kick transaction did not restore the one-WIRE minimum"
          )
        }
      ),
      verifyStep(
        Actor.Sysio,
        "last-kick-advanced",
        "kickpools.last_kick advanced to the kick's block: the whole interval was paid",
        async (ctx, signal) => {
          signal.throwIfAborted()
          const before = ctx.outputs.assert(LIQKickerScenario.BeforeKickKey),
            after = ctx.outputs.assert(LIQKickerScenario.AfterKickKey),
            receipt = ctx.outputs.assert(LIQKickerScenario.KickReceiptKey)
          Assert.ok(
            lastKickMicros(after.pool) > lastKickMicros(before.pool),
            `last_kick did not advance (${before.pool.last_kick} → ${after.pool.last_kick})`
          )
          Assert.strictEqual(
            WireClient.chainTimeMs(after.pool.last_kick),
            WireClient.chainTimeMs(receipt.blockTime),
            "a fully paid kick moves last_kick to its own block time"
          )
        }
      ),
      verifyStep(
        Actor.Sysio,
        "gift-reaches-holders",
        "the budget, the lifetime total, sysio.liq's yield index and the treasury each moved by exactly the gift",
        async (ctx, signal) => {
          signal.throwIfAborted()
          assertLedgersMovedBy(
            ctx.outputs.assert(LIQKickerScenario.BeforeKickKey),
            ctx.outputs.assert(LIQKickerScenario.AfterKickKey),
            ctx.outputs.assert(LIQKickerScenario.KickReceiptKey).paid
          )
        }
      )
    )

    // Every capability probe and governance write is represented in the Report.
    ClusterBuildPhase.create(
      cluster,
      "CrankKick",
      "Observe one irreversible, capped crank payment",
      [],
      {
        timeoutMs:
          Constants.CrankPaymentTimeoutMs + ProtocolTiming.PollDeadlineBufferMs
      }
    ).push(
      LIQKickerScenario.planCapability(
        Actor.BatchOperator,
        "probe-kick-crank",
        "Read nodeop's registered options",
        depotWriteStepOptions
      ),
      LIQKickerScenario.planCrankRemove(
        Actor.Sysio,
        "remove-crank-pool",
        "Remove LIQETH before the isolated crank observation",
        depotWriteStepOptions
      ),
      LIQKickerScenario.planCrankAdd(
        Actor.Sysio,
        "add-crank-pool",
        "Re-add LIQETH with a new TWAP window",
        depotWriteStepOptions
      ),
      LIQKickerScenario.planCrankBudget(
        Actor.Sysio,
        "cap-crank-budget",
        "Give the crank a one-unit budget, preventing a second payment across a UTC rollover",
        depotWriteStepOptions
      ),
      verifyStep(
        Actor.BatchOperator,
        "crank-baseline",
        "Record the new observation clock and ledgers",
        async (ctx, signal) => {
          if (!ctx.outputs.assert(LIQKickerScenario.CapabilityKey)) return
          ctx.outputs.set(
            LIQKickerScenario.CrankBaselineKey,
            await readSnapshot(ctx, signal)
          )
        }
      ),
      LIQKickerScenario.planCrankLower(
        Actor.Sysio,
        "lower-crank-minimum",
        "Permit exactly one base-unit payment per day",
        depotWriteStepOptions
      ),
      verifyStep(
        Actor.BatchOperator,
        "crank-pays-gift",
        "Confirm the paying transaction in its irreversible block and verify its partial clock",
        LIQKickerScenario.runVerifyCrank,
        crankStepOptions
      ),
      verifyStep(
        Actor.BatchOperator,
        "crank-window-elapsed",
        "Wait for the observation window the crank payment restarted before probing the exhausted cap",
        LIQKickerScenario.runCrankWindow,
        {
          timeoutMs:
            Constants.MinIntervalTimeoutMs + ProtocolTiming.PollDeadlineBufferMs
        }
      ),
      LIQKickerScenario.planValidationCase(
        LIQKickerScenario.ValidationCase.capExhausted
      ),
      LIQKickerScenario.planCrankRestore(
        Actor.Sysio,
        "restore-min-gift",
        "Restore the bootstrap pool's minimum and daily cap",
        depotWriteStepOptions
      ),
      LIQKickerScenario.planCrankBudgetRestore(
        Actor.Sysio,
        "restore-crank-budget",
        "Restore the remaining budget less the crank and any rollover recovery gift",
        depotWriteStepOptions
      )
    )
  }
}

/** The scenario's step factories, capability probe and typed cross-step outputs. */
export namespace LIQKickerScenario {
  /** Bound the help child by the same local-operation envelope as a depot write. */
  const HelpProbeTimeoutMs = ProtocolTiming.IrreversibilityBaseMs
  /** Bound captured help text. */
  const HelpProbeMaxBuffer = 16 * 1024 * 1024

  /** Input of the process probe; the executable is resolved from context at execution. */
  export interface CapabilityInput extends StepInput {
    readonly kind: "LIQKickerScenario.CapabilityInput"
  }
  /** Plan the nodeop help process as a named Report Step. */
  export function planCapability<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, CapabilityInput> {
    return ClusterBuildStep.create(
      actor,
      name,
      description,
      options,
      { kind: "LIQKickerScenario.CapabilityInput" },
      runCapability
    )
  }
  /** Probe errors fail the Report; only successful help lacking the option means unavailable. */
  export async function runCapability<C extends ClusterBuildContext>(
    ctx: C,
    _input: CapabilityInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const nodeop = ctx.config.executables.nodeop
    Assert.ok(
      nodeop,
      "nodeop executable is required for the kick capability probe"
    )
    const help = await Deferred.useCallback<string>(deferred => {
        ChildProcess.execFile(
          nodeop,
          ["--help"],
          {
            encoding: "utf8",
            timeout: scaleTimeoutMs(HelpProbeTimeoutMs),
            maxBuffer: HelpProbeMaxBuffer,
            signal
          },
          (error, stdout, stderr) => {
            if (error) {
              log.error(`nodeop help failed: ${stderr}`, error)
              deferred.reject(error)
            } else deferred.resolve(stdout)
          }
        )
      }).promise,
      available = help.includes(Constants.KickCrankOption)
    ctx.outputs.set(CapabilityKey, available)
    StepExtraRecorder.record({
      client: "nodeop",
      kind: "cli",
      executable: nodeop,
      args: ["--help"],
      available
    })
    if (!available)
      log.warn(
        `nodeop help lacks ${Constants.KickCrankOption}; crank observation unavailable`
      )
  }

  /** Capability-gated governance steps retain their typed ABI inputs in the Report. */
  export function planCrankRemove<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ) {
    return ClusterBuildStep.create<C, Steps.contracts.sysio.kicker.RmpoolInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "KickerContractSteps.RmpoolInput",
        data: { sym: Constants.LIQTokenCodename }
      },
      runCrankRemove
    )
  }
  /** Remove only after a successful positive capability probe. */
  export async function runCrankRemove<C extends ClusterBuildContext>(
    ctx: C,
    input: Steps.contracts.sysio.kicker.RmpoolInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    if (ctx.outputs.assert(CapabilityKey))
      await Steps.contracts.sysio.kicker.runRmpool(ctx, input, signal)
  }
  /** Plan re-registration with a one-unit cap so another payment cannot interleave with the reads. */
  export function planCrankAdd<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ) {
    return ClusterBuildStep.create<
      C,
      Steps.contracts.sysio.kicker.AddpoolInput
    >(
      actor,
      name,
      description,
      options,
      {
        kind: "KickerContractSteps.AddpoolInput",
        data: setpoolData(Constants.RestoredMinGift)
      },
      runCrankAdd
    )
  }
  /** Re-add only when a crank can run. */
  export async function runCrankAdd<C extends ClusterBuildContext>(
    ctx: C,
    input: Steps.contracts.sysio.kicker.AddpoolInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    if (ctx.outputs.assert(CapabilityKey))
      await Steps.contracts.sysio.kicker.runAddpool(ctx, input, signal)
  }
  /** Plan the one-unit daily cap after the unpaid baseline was captured. */
  export function planCrankLower<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ) {
    return ClusterBuildStep.create<
      C,
      Steps.contracts.sysio.kicker.SetpoolInput
    >(
      actor,
      name,
      description,
      options,
      {
        kind: "KickerContractSteps.SetpoolInput",
        data: {
          ...setpoolData(Constants.PayableMinGift),
          max_gift_per_day: Constants.CrankDailyCap
        }
      },
      runCrankRestore
    )
  }
  /** Plan an absolute one-unit budget for the isolated observation. */
  export function planCrankBudget<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ) {
    return ClusterBuildStep.create<
      C,
      Steps.contracts.sysio.kicker.SetconfigInput
    >(
      actor,
      name,
      description,
      options,
      {
        kind: "KickerContractSteps.SetconfigInput",
        data: {
          cfg: {
            ...Steps.registry.KickerConfiguration.cfg,
            twap_window_sec: Constants.TwapWindowSec,
            budget_remaining: Constants.CrankDailyCap
          }
        }
      },
      runCrankBudget
    )
  }
  /** Lower the budget only after the capability probe succeeds. */
  export async function runCrankBudget<C extends ClusterBuildContext>(
    ctx: C,
    input: Steps.contracts.sysio.kicker.SetconfigInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    if (ctx.outputs.assert(CapabilityKey))
      await Steps.contracts.sysio.kicker.runSetconfig(ctx, input, signal)
  }
  /** Plan restoring the original remaining budget less the observed gift. */
  export function planCrankBudgetRestore<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ) {
    return ClusterBuildStep.create<C, CapabilityInput>(
      actor,
      name,
      description,
      options,
      { kind: "LIQKickerScenario.CapabilityInput" },
      runCrankBudgetRestore
    )
  }
  /** Restore budget conservation after the crank and any atomic rollover recovery. */
  export async function runCrankBudgetRestore<C extends ClusterBuildContext>(
    ctx: C,
    _input: CapabilityInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    if (!ctx.outputs.assert(CapabilityKey)) return
    const config = ctx.outputs.assert(AfterKickKey).config,
      pool = await readKickerPool(ctx),
      paid =
        BigInt(pool.gifted_total) -
        BigInt(ctx.outputs.assert(CrankBaselineKey).pool.gifted_total)
    await Steps.contracts.sysio.kicker.runSetconfig(
      ctx,
      {
        kind: "KickerContractSteps.SetconfigInput",
        data: {
          cfg: {
            ...config,
            budget_remaining: (
              BigInt(config.budget_remaining) - paid
            ).toString()
          }
        }
      },
      signal
    )
  }
  /** Plan restoration of governance defaults. */
  export function planCrankRestore<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ) {
    return ClusterBuildStep.create<
      C,
      Steps.contracts.sysio.kicker.SetpoolInput
    >(
      actor,
      name,
      description,
      options,
      {
        kind: "KickerContractSteps.SetpoolInput",
        data: setpoolData(Constants.RestoredMinGift)
      },
      runCrankRestore
    )
  }
  /** Restore only when the observation was enabled. */
  export async function runCrankRestore<C extends ClusterBuildContext>(
    ctx: C,
    input: Steps.contracts.sysio.kicker.SetpoolInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    if (ctx.outputs.assert(CapabilityKey))
      await Steps.contracts.sysio.kicker.runSetpool(ctx, input, signal)
  }

  /** Nodeop's structured log trace, using the existing action-trace view. */
  export interface CrankTrace {
    readonly id: WireClient.GetTransactionResponse["id"]
    readonly block_time: WireClient.GetTransactionResponse["block_time"]
    readonly except?: unknown
    readonly action_traces: ActionTraceView[]
  }

  /** Confirm a logged payment in its actual irreversible block; a reversible or forked trace cannot pass. */
  export async function irreversibleCrank(
    ctx: ClusterBuildContext,
    traces: CrankTrace[],
    before: KickerSnapshot,
    signal: AbortSignal
  ): Promise<KickReceipt> {
    const lib = (await ctx.wire.getInfo()).last_irreversible_block_num
    for (const trace of traces) {
      signal.throwIfAborted()
      if (
        trace.except != null ||
        WireClient.chainTimeMs(trace.block_time) <=
          WireClient.chainTimeMs(before.pool.last_kick)
      )
        continue
      const actions = flattenTraces(trace.action_traces),
        kicks = actions.filter(
          action =>
            action.receiver === Constants.KickerAccount &&
            action.act?.account === Constants.KickerAccount &&
            action.act.name === Constants.KickActionName &&
            (action.act.data as SysioContracts.SysioKickerKickAction).sym ===
              Constants.LIQTokenCodename
        ),
        draws = actions.filter(
          action =>
            action.receiver === Constants.TokenAccount &&
            action.act?.account === Constants.TokenAccount &&
            action.act.name === Constants.TransferActionName &&
            (action.act.data as SysioContracts.SysioTokenTransferAction)
              .from === Constants.TreasuryAccount &&
            (action.act.data as SysioContracts.SysioTokenTransferAction).to ===
              Constants.KickerAccount
        )
      if (kicks.length !== 1 || draws.length !== 1) continue
      const transaction = await ctx.wire.getTransaction(trace.id)
      if (
        !transaction ||
        transaction.block_num > lib ||
        WireClient.chainTimeMs(transaction.block_time) !==
          WireClient.chainTimeMs(trace.block_time)
      )
        continue
      const block = await ctx.wire.getBlock(transaction.block_num)
      if (!WireClient.blockContainsTransaction(block, trace.id)) continue
      assertNoEmissionsMutation(trace.action_traces)
      return {
        paid: assetUnits(
          (draws[0].act.data as SysioContracts.SysioTokenTransferAction)
            .quantity
        ),
        blockTime: transaction.block_time
      }
    }
    return null
  }

  /** Read raw process traces; their inclusion is checked separately against LIB. */
  async function readCrankTraces(
    ctx: ClusterBuildContext
  ): Promise<CrankTrace[]> {
    const directory = Path.join(ctx.config.clusterPath, "logs"),
      files = (await Fs.readdir(directory)).filter(file =>
        /^cluster_.*\.log$/.test(file)
      ),
      logs = await Promise.all(
        files.map(file => Fs.readFile(Path.join(directory, file), "utf8"))
      )
    // ProcessManager.writeRaw owns this heartbeat artifact. It always writes
    // text, independently of the structured logger's configured file format.
    return logs.flatMap(text =>
      parseCrankTraces(text, LogFileAppender.Format.text)
    )
  }

  /**
   * Decode complete harness records, leaving an active writer's final line unread.
   * @param text - Current file contents, including any unfinished final record.
   * @param format - Persisted harness log format.
   * @returns Candidate traces; irreversible inclusion is verified separately.
   */
  export function parseCrankTraces(
    text: string,
    format: LogFileAppender.Format
  ): CrankTrace[] {
    return text
      .split("\n")
      .slice(0, -1)
      .flatMap(line =>
        match(format)
          .with(LogFileAppender.Format.text, () => [line])
          .with(LogFileAppender.Format.jsonl, () =>
            match(JSON.parse(line) as unknown)
              .with(
                { message: P.string, args: P.optional(P.array(P.unknown)) },
                ({ message, args = [] }) => [message, ...args.filter(isString)]
              )
              .otherwise(() => {
                throw new Error("Malformed cluster log record")
              })
          )
          .exhaustive()
      )
      .map(stripVTControlCharacters)
      .filter(
        line =>
          line.includes("[TRX_TRACE]") && line.includes(Constants.KickerAccount)
      )
      .flatMap(line => {
        const start = line.indexOf('{"id":')
        return start < 0 ? [] : [JSON.parse(line.slice(start)) as CrankTrace]
      })
  }

  /** Verify the unique capped payment, its TWAP, partial clock, budget and yield ledgers. */
  export async function runVerifyCrank(
    ctx: ClusterBuildContext,
    signal: AbortSignal
  ): Promise<void> {
    if (!ctx.outputs.assert(CapabilityKey)) return
    signal.throwIfAborted()
    const before = ctx.outputs.assert(CrankBaselineKey)
    let receipt: KickReceipt
    await pollUntil(
      "an irreversible crank payment",
      async () => {
        signal.throwIfAborted()
        receipt = await irreversibleCrank(
          ctx,
          await readCrankTraces(ctx),
          before,
          signal
        )
        return receipt != null
      },
      Constants.CrankPaymentTimeoutMs,
      Constants.PollIntervalMs
    )
    const after = await readSnapshot(ctx, signal),
      { rows } = await ctx.wire
        .getSysioContract(SysioContractName.swap)
        .tables.priceaccum.query(symbolRange(Constants.PairTokenCodename)),
      now =
        BigInt(WireClient.chainTimeMs(receipt.blockTime)) *
        Constants.MicrosPerMillisecond,
      gift = expectedGiftAtBlock(before, rows[0], receipt.blockTime),
      elapsed = now - lastKickMicros(before.pool),
      capped =
        gift < BigInt(Constants.CrankDailyCap)
          ? gift
          : BigInt(Constants.CrankDailyCap)
    Assert.strictEqual(after.poolWire, before.poolWire)
    Assert.strictEqual(after.poolShadow, before.poolShadow)
    Assert.strictEqual(after.supply, before.supply)
    Assert.ok(gift > 0n, "the crank accrued no gift")
    const boundedElapsed =
        elapsed > LIQKickerAccrual.MaxCatchupMicros
          ? LIQKickerAccrual.MaxCatchupMicros
          : elapsed,
      advanced = now - boundedElapsed + (boundedElapsed * capped) / gift
    Assert.strictEqual(
      BigInt(after.pool.supply_snapshot),
      before.supply < BigInt(before.pool.supply_snapshot)
        ? before.supply
        : BigInt(before.pool.supply_snapshot)
    )
    Assert.ok(
      gift > capped,
      "the crank fixture must produce a partial daily-cap payment"
    )
    Assert.strictEqual(receipt.paid, capped)
    Assert.strictEqual(
      lastKickMicros(after.pool),
      (advanced / Constants.MicrosPerMillisecond) *
        Constants.MicrosPerMillisecond,
      "partial payment clock did not advance pro rata"
    )
    Assert.strictEqual(
      LIQKickerAccrual.cumulative(after.pool.price_snapshot),
      cumulativeAtBlock(before, rows[0], receipt.blockTime),
      "a payment settles the TWAP baseline at its own block"
    )
    Assert.strictEqual(
      WireClient.chainTimeMs(after.pool.price_time),
      WireClient.chainTimeMs(receipt.blockTime)
    )
    assertSpotWithinGuard(before, after)
    ctx.outputs.set(CrankClockKey, advanced)
    assertLedgersMovedBy(before, after, capped)
    log.info(`irreversible crank paid=${capped}; uncapped TWAP gift=${gift}`)
  }

  /** Wait for the crank payment's restarted observation window, only when the crank ran. */
  export async function runCrankWindow(
    ctx: ClusterBuildContext,
    signal: AbortSignal
  ): Promise<void> {
    if (ctx.outputs.assert(CapabilityKey)) await runWaitWindow(ctx, signal)
  }

  /** Wait for the observation window, checking the step's cancellation on every poll. */
  export async function runWaitWindow(
    ctx: ClusterBuildContext,
    signal: AbortSignal
  ): Promise<void> {
    const [config, pool] = await Promise.all([
        readKickerConfig(ctx),
        readKickerPool(ctx)
      ]),
      due = Math.max(
        WireClient.chainTimeMs(pool.price_time) +
          config.twap_window_sec * ProtocolTiming.MsPerSecond,
        WireClient.chainTimeMs(pool.last_kick) +
          config.min_interval_sec * ProtocolTiming.MsPerSecond
      )
    await pollUntil(
      "kicker observation window",
      async () => {
        signal.throwIfAborted()
        return (
          WireClient.chainTimeMs((await ctx.wire.getInfo()).head_block_time) >=
          due
        )
      },
      Constants.MinIntervalTimeoutMs,
      Constants.PollIntervalMs
    )
  }

  /**
   * Wait for the zero-snapshot probe's interval while automatic kicks remain held.
   * @param ctx - Cluster context used to read the pool and chain clock.
   * @param signal - Cancellation of the Report step.
   * @returns Resolves once the one-second checkpoint interval has matured.
   */
  export async function runWaitCheckpoint(
    ctx: ClusterBuildContext,
    signal: AbortSignal
  ): Promise<void> {
    const pool = await readKickerPool(ctx),
      due =
        WireClient.chainTimeMs(pool.last_kick) +
        Constants.ValidationMinIntervalSec * ProtocolTiming.MsPerSecond
    await pollUntil(
      "kicker supply checkpoint interval",
      async () => {
        signal.throwIfAborted()
        return (
          WireClient.chainTimeMs((await ctx.wire.getInfo()).head_block_time) >=
          due
        )
      },
      Constants.MinIntervalTimeoutMs,
      Constants.PollIntervalMs
    )
  }

  /** Governance configuration restored after the protected zero-supply/checkpoint probes. */
  export const ZeroSupplyConfigKey =
    outputKey<SysioContracts.SysioKickerKickConfigType>(
      "LIQKickerScenario.zeroSupplyConfig",
      "the configuration before holding automatic kicks around the zero-snapshot probe"
    )

  /** Contract-validation branches with a separate, reportable transaction for each. */
  export enum ValidationCase {
    windowFloor = "windowFloor",
    intervalFloor = "intervalFloor",
    budgetBounds = "budgetBounds",
    spotDeviationFloor = "spotDeviationFloor",
    spotDeviationBounds = "spotDeviationBounds",
    zeroCap = "zeroCap",
    capBelowMinimum = "capBelowMinimum",
    capBounds = "capBounds",
    rateBounds = "rateBounds",
    minimumFloor = "minimumFloor",
    duplicatePool = "duplicatePool",
    unknownKick = "unknownKick",
    unknownSetpool = "unknownSetpool",
    unknownRmpool = "unknownRmpool",
    unauthorizedConfig = "unauthorizedConfig",
    unauthorizedAdd = "unauthorizedAdd",
    unauthorizedSetpool = "unauthorizedSetpool",
    unauthorizedRemove = "unauthorizedRemove",
    warmupSetup = "warmupSetup",
    warmup = "warmup",
    minimumInterval = "minimumInterval",
    belowMinimum = "belowMinimum",
    zeroSupply = "zeroSupply",
    zeroSnapshot = "zeroSnapshot",
    budgetShortfall = "budgetShortfall",
    treasuryShortfall = "treasuryShortfall",
    capExhausted = "capExhausted",
    inlineRollback = "inlineRollback",
    inlineFailure = "inlineFailure",
    andonHold = "andonHold"
  }
  /** One validation transaction, with its semantic expected outcome. */
  export interface ValidationInput extends StepInput {
    readonly kind: "LIQKickerScenario.ValidationInput"
    readonly test: ValidationCase
  }
  /** Unknown symbol used to prove all pool-lookup rejection paths. */
  const UnknownSymbol = "UNKNOWN"
  /** First forbidden gift cap, one unit above 1,000 WIRE. */
  const ForbiddenCap = Constants.MaxGiftPerDay + 1
  /** First forbidden spot guard above the ceiling: one basis point past 10,000. */
  const ForbiddenSpotDeviationBps = Number(LIQKickerAccrual.BpsScale) + 1
  /** `sysio.kicker::setconfig`'s refusal of a spot guard outside 1..10,000 bps. */
  const InvalidSpotDeviation = "spot deviation must be 1 to 10000 bps"
  /** First forbidden protocol asset amount. */
  const ForbiddenBudget = (1n << 62n).toString()
  /** A floor exceeding any interval in this phase; it is restored atomically. */
  const HeldIntervalSec = 4_294_967_295
  /** Plan one typed validation transaction. */
  export function planValidationCase<
    C extends ClusterBuildContext = ClusterBuildContext
  >(test: ValidationCase): ClusterBuildStep<C, ValidationInput> {
    return ClusterBuildStep.create(
      Actor.Sysio,
      `kicker-${test}`,
      `Verify kicker ${test}`,
      {
        timeoutMs:
          Constants.DepotWriteTimeoutMs +
          2 * Constants.SnapshotTimeoutMs +
          ProtocolTiming.PollDeadlineBufferMs
      },
      { kind: "LIQKickerScenario.ValidationInput", test },
      runValidation
    )
  }
  /** Reject malformed governance inputs, exercise removal/re-addition, and prove unchanged clocks on skips. */
  export function planValidation(cluster: ClusterBuild): void {
    ClusterBuildPhase.create(
      cluster,
      "KickerValidation",
      "Exercise governance failures and non-paying kicks"
    ).push(
      ...Object.values(ValidationCase)
        .filter(test => test !== ValidationCase.capExhausted)
        .flatMap(test =>
          test === ValidationCase.zeroSnapshot ||
          test === ValidationCase.budgetShortfall
            ? [
                verifyStep(
                  Actor.Sysio,
                  `warmup-elapsed-${test}`,
                  test === ValidationCase.zeroSnapshot
                    ? "Wait for the one-second supply checkpoint interval with automatic kicks held"
                    : "Wait for the governance TWAP window before testing funding shortfalls",
                  test === ValidationCase.zeroSnapshot
                    ? runWaitCheckpoint
                    : runWaitWindow,
                  {
                    timeoutMs:
                      Constants.MinIntervalTimeoutMs +
                      ProtocolTiming.PollDeadlineBufferMs
                  }
                ),
                planValidationCase(test)
              ]
            : [planValidationCase(test)]
        )
    )
  }
  /** Execute a case in one atomic transaction to isolate it from the live crank. */
  export async function runValidation(
    ctx: ClusterBuildContext,
    input: ValidationInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    if (
      input.test === ValidationCase.capExhausted &&
      !ctx.outputs.assert(CapabilityKey)
    )
      return
    const before = await readSnapshot(ctx, signal),
      kicker = ctx.wire.getSysioContract(SysioContractName.kicker),
      governance = {
        authorization: Steps.contracts.sysio.kicker.GovernanceAuthorization
      },
      keeper = {
        authorization: WireClient.activeAuthorization(Constants.KickerAccount)
      },
      config = (patch: Partial<SysioContracts.SysioKickerKickConfigType>) =>
        kicker.actions.setconfig.prepare(
          { cfg: { ...before.config, ...patch } },
          governance
        ),
      pool = (patch: Partial<SysioContracts.SysioKickerSetpoolAction>) =>
        kicker.actions.setpool.prepare(
          { ...setpoolData(Constants.RestoredMinGift), ...patch },
          governance
        ),
      kick = kicker.actions.kick.prepare(
        { sym: Constants.LIQTokenCodename },
        keeper
      ),
      restore = pool({}),
      test = input.test
    let response: API.v1.SendTransactionResponse,
      expectedError: string,
      actions: Parameters<WireClient["invokeTransaction"]>
    const add = kicker.actions.addpool.prepare(
        setpoolData(Constants.RestoredMinGift),
        governance
      ),
      remove = kicker.actions.rmpool.prepare(
        { sym: Constants.LIQTokenCodename },
        governance
      )
    let emissionConfig: SysioContracts.SysioSystemEmissionConfigType
    await match(test)
      .with(ValidationCase.windowFloor, () => {
        actions = [config({ twap_window_sec: Constants.TwapWindowSec - 1 })]
        expectedError = "TWAP window must be at least 60 seconds"
      })
      .with(ValidationCase.intervalFloor, () => {
        actions = [config({ min_interval_sec: 0 })]
        expectedError = "minimum interval must be positive"
      })
      .with(ValidationCase.budgetBounds, () => {
        actions = [config({ budget_remaining: ForbiddenBudget })]
        expectedError = "budget exceeds asset range"
      })
      .with(ValidationCase.spotDeviationFloor, () => {
        actions = [config({ max_spot_deviation_bps: 0 })]
        expectedError = InvalidSpotDeviation
      })
      .with(ValidationCase.spotDeviationBounds, () => {
        actions = [
          config({ max_spot_deviation_bps: ForbiddenSpotDeviationBps })
        ]
        expectedError = InvalidSpotDeviation
      })
      .with(ValidationCase.zeroCap, () => {
        actions = [pool({ max_gift_per_day: 0 })]
        expectedError = "invalid daily cap"
      })
      .with(ValidationCase.capBelowMinimum, () => {
        actions = [pool({ max_gift_per_day: Constants.RestoredMinGift - 1 })]
        expectedError = "invalid daily cap"
      })
      .with(ValidationCase.capBounds, () => {
        actions = [pool({ max_gift_per_day: ForbiddenCap })]
        expectedError = "invalid daily cap"
      })
      .with(ValidationCase.rateBounds, () => {
        actions = [pool({ rate_bps: Number(LIQKickerAccrual.BpsScale) + 1 })]
        expectedError = "rate exceeds 10000 bps"
      })
      .with(ValidationCase.minimumFloor, () => {
        actions = [pool({ min_gift: 0 })]
        expectedError = "invalid minimum gift"
      })
      .with(ValidationCase.duplicatePool, () => {
        actions = [add]
        expectedError = "pool already configured"
      })
      .with(ValidationCase.unknownKick, () => {
        actions = [kicker.actions.kick.prepare({ sym: UnknownSymbol }, keeper)]
        expectedError = "unknown kicker pool"
      })
      .with(ValidationCase.unknownSetpool, () => {
        actions = [pool({ sym: UnknownSymbol })]
        expectedError = "unknown kicker pool"
      })
      .with(ValidationCase.unknownRmpool, () => {
        actions = [
          kicker.actions.rmpool.prepare({ sym: UnknownSymbol }, governance)
        ]
        expectedError = "unknown kicker pool"
      })
      .with(ValidationCase.unauthorizedConfig, () => {
        actions = [
          kicker.actions.setconfig.prepare({ cfg: before.config }, keeper)
        ]
        expectedError = "missing authority of sysio"
      })
      .with(ValidationCase.unauthorizedAdd, () => {
        actions = [
          kicker.actions.addpool.prepare(
            setpoolData(Constants.RestoredMinGift),
            keeper
          )
        ]
        expectedError = "missing authority of sysio"
      })
      .with(ValidationCase.unauthorizedSetpool, () => {
        actions = [
          kicker.actions.setpool.prepare(
            setpoolData(Constants.RestoredMinGift),
            keeper
          )
        ]
        expectedError = "missing authority of sysio"
      })
      .with(ValidationCase.unauthorizedRemove, () => {
        actions = [
          kicker.actions.rmpool.prepare(
            { sym: Constants.LIQTokenCodename },
            keeper
          )
        ]
        expectedError = "missing authority of sysio"
      })
      .with(ValidationCase.warmupSetup, () => {
        actions = [
          config({
            min_interval_sec: Constants.ValidationMinIntervalSec,
            twap_window_sec: Steps.registry.KickerTwapWindowSec
          }),
          remove,
          add
        ]
      })
      .with(ValidationCase.warmup, () => {
        actions = [
          pool({ min_gift: Constants.PayableMinGift }),
          kick,
          restore,
          config({
            min_interval_sec: Steps.registry.KickerMinIntervalSec,
            twap_window_sec: Constants.TwapWindowSec
          })
        ]
      })
      .with(ValidationCase.minimumInterval, () => {
        actions = [
          config({ min_interval_sec: HeldIntervalSec }),
          pool({ min_gift: Constants.PayableMinGift }),
          kick,
          restore,
          config({})
        ]
      })
      .with(ValidationCase.belowMinimum, () => {
        actions = [kick]
      })
      .with(ValidationCase.capExhausted, () => {
        Assert.strictEqual(BigInt(before.config.budget_remaining), 0n)
        Assert.strictEqual(
          BigInt(before.pool.min_gift),
          BigInt(Constants.PayableMinGift)
        )
        Assert.strictEqual(
          BigInt(before.pool.spent_today),
          BigInt(before.pool.max_gift_per_day)
        )
        // Both kicks execute at the SAME chain time. The first re-exhausts the cap
        // if midnight passed, without restarting TWAP; the second probes that cap
        // with positive budget. Zero budget is restored before any crank can run.
        actions = [
          config({ budget_remaining: Constants.CrankDailyCap }),
          kick,
          config({ budget_remaining: Constants.CapProbeBudget }),
          kick,
          config({})
        ]
      })
      .with(ValidationCase.budgetShortfall, () => {
        actions = [
          config({ budget_remaining: 0 }),
          pool({ min_gift: Constants.PayableMinGift }),
          kick,
          restore,
          config({})
        ]
      })
      .with(ValidationCase.treasuryShortfall, async () => {
        const system = ctx.wire.getSysioContract(SysioContractName.system),
          { rows: configs } = await system.tables.emitcfg.query({ limit: 1 }),
          { rows: states } = await system.tables.t5state.query({ limit: 1 })
        Assert.strictEqual(configs.length, 1)
        Assert.strictEqual(states.length, 1)
        emissionConfig = configs[0]
        Assert.ok(BigInt(before.config.budget_remaining) > 0n)
        Assert.ok(
          BigInt(Constants.TreasuryReservationCeiling) -
            BigInt(states[0].total_distributed) >=
            before.holdings.treasury + before.holdings.categoryBuckets,
          "reservation fixture does not cover the treasury"
        )
        // payepoch only reduces the treasury + remaining ceiling together. Reserve all
        // available WIRE atomically; no stale balance transfer and no epoch sees this config.
        actions = [
          system.actions.setemitcfg.prepare(
            {
              cfg: {
                ...emissionConfig,
                t5_distributable: Constants.TreasuryReservationCeiling,
                t5_floor: 0
              }
            },
            governance
          ),
          pool({ min_gift: Constants.PayableMinGift }),
          kick,
          restore,
          system.actions.setemitcfg.prepare({ cfg: emissionConfig }, governance)
        ]
      })
      .with(ValidationCase.inlineRollback, () => {
        actions = [
          pool({ min_gift: Constants.PayableMinGift }),
          kick,
          pool({ max_gift_per_day: 0 })
        ]
        expectedError = "invalid daily cap"
      })
      .with(ValidationCase.inlineFailure, () => {
        const system = ctx.wire.getSysioContract(SysioContractName.system)
        actions = [
          system.actions.setpriv.prepare(
            { account: Constants.KickerAccount, is_priv: 0 },
            governance
          ),
          pool({ min_gift: Constants.PayableMinGift }),
          kick,
          system.actions.setpriv.prepare(
            { account: Constants.KickerAccount, is_priv: 1 },
            governance
          ),
          restore
        ]
        expectedError = "authorization"
      })
      .with(ValidationCase.zeroSnapshot, () => {
        Assert.strictEqual(BigInt(before.pool.supply_snapshot), 0n)
        Assert.ok(before.supply > 0n)
        actions = [
          config({ min_interval_sec: Constants.ValidationMinIntervalSec }),
          kick,
          kicker.actions.setconfig.prepare(
            { cfg: ctx.outputs.assert(ZeroSupplyConfigKey) },
            governance
          )
        ]
      })
      .with(ValidationCase.zeroSupply, () => {
        ctx.outputs.set(ZeroSupplyConfigKey, before.config)
        const liq = ctx.wire.getSysioContract(SysioContractName.liq),
          swap = SysioContracts.SysioContractAccount[SysioContractName.swap],
          synd = SysioContracts.SysioContractAccount[SysioContractName.synd],
          quantity = Asset.fromUnits(
            before.supply.toString(),
            Constants.ShadowAssetSymbol
          ).toString(),
          syndAuthority = {
            authorization: WireClient.activeAuthorization(synd)
          }
        // Burn and restore the mock pool's whole supply atomically; no outpost or epoch observes it empty.
        actions = [
          config({ min_interval_sec: Constants.ValidationMinIntervalSec }),
          liq.actions.transfer.prepare(
            { from: swap, to: synd, quantity, memo: Constants.ZeroSupplyMemo },
            { authorization: WireClient.activeAuthorization(swap) }
          ),
          liq.actions.burn.prepare(
            {
              token_code: Constants.LIQTokenCodename,
              amount: before.supply.toString()
            },
            syndAuthority
          ),
          kick,
          liq.actions.mint.prepare(
            {
              to: swap,
              token_code: Constants.LIQTokenCodename,
              amount: before.supply.toString()
            },
            syndAuthority
          ),
          config({ min_interval_sec: HeldIntervalSec })
        ]
      })
      .with(ValidationCase.andonHold, () => {
        const andon = ctx.wire.getSysioContract(SysioContractName.andon),
          account = SysioContracts.SysioContractAccount[SysioContractName.andon]
        actions = [
          andon.actions.pull.prepare(
            { reason: Constants.AndonHoldReason },
            {
              authorization: [
                {
                  actor: account,
                  permission: Steps.contracts.sysio.andon.Permission.pull
                }
              ]
            }
          ),
          pool({ min_gift: Constants.PayableMinGift }),
          kick,
          restore,
          andon.actions.clear.prepare(
            { note: Constants.AndonClearNote },
            {
              authorization: [
                {
                  actor: account,
                  permission: Steps.contracts.sysio.andon.Permission.clear
                }
              ]
            }
          )
        ]
      })
      .exhaustive()
    Assert.ok(actions, `unhandled kicker validation case ${test}`)
    if (expectedError) {
      let rejected = false
      try {
        await ctx.wire.invokeTransaction(...actions)
      } catch (error) {
        log.info(`expected ${test} rejection`, error)
        Assert.ok(
          error instanceof Error &&
            (test === ValidationCase.inlineFailure
              ? /authorization|authority|permission/.test(error.message)
              : error.message.includes(expectedError)),
          `unexpected ${test} rejection: ${error}`
        )
        rejected = true
      }
      Assert.ok(rejected, `${test} unexpectedly succeeded`)
    } else {
      const result = await ctx.wire.invokeTransaction(...actions),
        transfers = flattenTraces(
          result.processed.action_traces as ActionTraceView[]
        ).filter(
          trace =>
            trace.receiver === Constants.TokenAccount &&
            trace.act?.name === Constants.TransferActionName &&
            (trace.act.data as TransferData).from ===
              Constants.TreasuryAccount &&
            (trace.act.data as TransferData).to === Constants.KickerAccount
        )
      response = result
      Assert.strictEqual(
        transfers.length,
        test === ValidationCase.capExhausted &&
          BigInt(
            Math.floor(
              WireClient.chainTimeMs(result.processed.block_time) /
                Constants.MsPerDay
            )
          ) > BigInt(before.pool.day)
          ? 1
          : 0,
        `${test} unexpectedly paid`
      )
    }
    const after = await readSnapshot(ctx, signal)
    if (test === ValidationCase.capExhausted) {
      const day = BigInt(
          Math.floor(
            WireClient.chainTimeMs(response.processed.block_time) /
              Constants.MsPerDay
          )
        ),
        recovered = day > BigInt(before.pool.day),
        paid = recovered ? BigInt(Constants.CrankDailyCap) : 0n,
        clock = ctx.outputs.assert(CrankClockKey),
        now =
          BigInt(WireClient.chainTimeMs(response.processed.block_time)) *
          Constants.MicrosPerMillisecond,
        { rows } = await ctx.wire
          .getSysioContract(SysioContractName.swap)
          .tables.priceaccum.query(symbolRange(Constants.PairTokenCodename)),
        gift = expectedGiftAtBlock(
          before,
          rows[0],
          response.processed.block_time,
          clock
        ),
        elapsed = now - clock,
        boundedElapsed =
          elapsed > LIQKickerAccrual.MaxCatchupMicros
            ? LIQKickerAccrual.MaxCatchupMicros
            : elapsed
      Assert.ok(
        day >= BigInt(before.pool.day),
        "cap probe executed before the exhausted day"
      )
      Assert.ok(
        gift > BigInt(Constants.CrankDailyCap),
        "cap recovery must remain a partial payment"
      )
      const advanced = recovered
        ? now - boundedElapsed + (boundedElapsed * paid) / gift
        : clock
      Assert.ok(
        now - clock >=
          BigInt(before.config.min_interval_sec) *
            LIQKickerAccrual.MicrosPerSecond,
        "cap probe must pass the interval gate"
      )
      Assert.strictEqual(
        BigInt(after.pool.supply_snapshot),
        recovered && before.supply < BigInt(before.pool.supply_snapshot)
          ? before.supply
          : BigInt(before.pool.supply_snapshot)
      )
      if (recovered) Assert.strictEqual(kickReceipt(response).paid, paid)
      assertLedgersMovedBy(
        {
          ...before,
          config: { ...before.config, budget_remaining: paid.toString() }
        },
        after,
        paid
      )
      Assert.strictEqual(after.supply, before.supply)
      Assert.strictEqual(after.poolWire, before.poolWire)
      Assert.strictEqual(after.poolShadow, before.poolShadow)
      Assert.deepStrictEqual(
        after.config,
        before.config,
        "cap probe did not restore zero budget"
      )
      Assert.strictEqual(
        lastKickMicros(after.pool),
        (advanced / Constants.MicrosPerMillisecond) *
          Constants.MicrosPerMillisecond
      )
      // A recovery payment settles the TWAP baseline at its block, so the second kick
      // in the same block stops at the observation gate and leaves the first's shortfall.
      if (recovered) {
        Assert.strictEqual(
          LIQKickerAccrual.cumulative(after.pool.price_snapshot),
          cumulativeAtBlock(before, rows[0], response.processed.block_time),
          "the recovery payment did not settle the TWAP baseline at its block"
        )
        Assert.strictEqual(
          WireClient.chainTimeMs(after.pool.price_time),
          WireClient.chainTimeMs(response.processed.block_time)
        )
      } else {
        Assert.strictEqual(after.pool.price_time, before.pool.price_time)
        Assert.deepStrictEqual(
          after.pool.price_snapshot,
          before.pool.price_snapshot
        )
      }
      Assert.strictEqual(after.pool.spot_deviation, false)
      Assert.strictEqual(
        BigInt(after.pool.spent_today),
        BigInt(before.pool.max_gift_per_day)
      )
      Assert.strictEqual(BigInt(after.pool.day), day)
      Assert.strictEqual(
        BigInt(after.pool.shortfall_amount),
        gift - paid,
        "cap probe did not record the exact unpaid gift"
      )
      Assert.strictEqual(
        WireClient.chainTimeMs(after.pool.shortfall_time),
        WireClient.chainTimeMs(response.processed.block_time)
      )
      ctx.outputs.set(CrankClockKey, advanced)
      return
    }
    if (test === ValidationCase.treasuryShortfall) {
      const { rows } = await ctx.wire
        .getSysioContract(SysioContractName.system)
        .tables.emitcfg.query({ limit: 1 })
      Assert.deepStrictEqual(
        rows,
        [emissionConfig],
        "treasury reservation configuration was not restored"
      )
    }
    if (test === ValidationCase.treasuryShortfall) {
      Assert.strictEqual(
        after.holdings.treasury + after.holdings.categoryBuckets,
        before.holdings.treasury + before.holdings.categoryBuckets,
        "treasury and category bucket holdings were not conserved"
      )
      Assert.strictEqual(
        after.holdings.kicker,
        before.holdings.kicker,
        "kicker holdings were not restored"
      )
    }
    if (test === ValidationCase.warmup) {
      const elapsedMs =
        WireClient.chainTimeMs(response.processed.block_time) -
        WireClient.chainTimeMs(before.pool.last_kick)
      Assert.ok(
        elapsedMs >=
          before.config.min_interval_sec * ProtocolTiming.MsPerSecond,
        "warm-up probe did not pass the minimum interval gate"
      )
      Assert.ok(
        elapsedMs < before.config.twap_window_sec * ProtocolTiming.MsPerSecond,
        "warm-up probe ran after the observation window"
      )
    }
    Assert.strictEqual(after.pool.gifted_total, before.pool.gifted_total)
    Assert.strictEqual(
      BigInt(after.config.budget_remaining),
      BigInt(before.config.budget_remaining)
    )
    Assert.deepStrictEqual(after.yieldIndex, before.yieldIndex)
    if (
      [
        ValidationCase.budgetShortfall,
        ValidationCase.treasuryShortfall
      ].includes(test)
    ) {
      const { rows } = await ctx.wire
          .getSysioContract(SysioContractName.swap)
          .tables.priceaccum.query(symbolRange(Constants.PairTokenCodename)),
        expected = expectedGiftAtBlock(
          before,
          rows[0],
          response.processed.block_time,
          lastKickMicros(before.pool)
        )
      Assert.ok(expected > 0n, `${test} had no accrued gift`)
      Assert.strictEqual(
        after.pool.spot_deviation,
        false,
        `${test} flagged a spot deviation`
      )
      Assert.strictEqual(
        BigInt(after.pool.shortfall_amount),
        expected,
        `${test} did not record the exact unpaid gift`
      )
      Assert.strictEqual(
        WireClient.chainTimeMs(after.pool.shortfall_time),
        WireClient.chainTimeMs(response.processed.block_time)
      )
    }
    if (
      expectedError ||
      [
        ValidationCase.minimumInterval,
        ValidationCase.warmup,
        ValidationCase.andonHold
      ].includes(test)
    )
      Assert.deepStrictEqual(after.pool, before.pool)
    if (test === ValidationCase.belowMinimum) {
      const { rows } = await ctx.wire
          .getSysioContract(SysioContractName.swap)
          .tables.priceaccum.query(symbolRange(Constants.PairTokenCodename)),
        input = giftInputAtBlock(
          before,
          rows[0],
          response.processed.block_time
        ),
        checkpoints =
          input.elapsedMicros >=
            BigInt(before.config.min_interval_sec) *
              LIQKickerAccrual.MicrosPerSecond &&
          WireClient.chainTimeMs(response.processed.block_time) -
            WireClient.chainTimeMs(before.pool.price_time) >=
            before.config.twap_window_sec * ProtocolTiming.MsPerSecond &&
          LIQKickerAccrual.checkpointsBelowMinimum(
            input,
            BigInt(before.pool.min_gift)
          )
      Assert.ok(LIQKickerAccrual.gift(input) < BigInt(before.pool.min_gift))
      if (checkpoints) {
        Assert.strictEqual(BigInt(after.pool.supply_snapshot), before.supply)
        Assert.strictEqual(
          WireClient.chainTimeMs(after.pool.last_kick),
          WireClient.chainTimeMs(response.processed.block_time)
        )
        Assert.strictEqual(BigInt(after.pool.shortfall_amount), 0n)
        Assert.strictEqual(WireClient.chainTimeMs(after.pool.shortfall_time), 0)
        Assert.strictEqual(after.pool.gift_overflow, false)
        Assert.strictEqual(after.pool.spot_deviation, false)
      } else Assert.deepStrictEqual(after.pool, before.pool)
      Assert.deepStrictEqual(
        after.pool.price_snapshot,
        before.pool.price_snapshot
      )
      Assert.strictEqual(after.pool.price_time, before.pool.price_time)
      return
    }
    if (
      test === ValidationCase.zeroSupply ||
      test === ValidationCase.zeroSnapshot
    ) {
      Assert.ok(
        WireClient.chainTimeMs(response.processed.block_time) -
          WireClient.chainTimeMs(before.pool.last_kick) >=
          Constants.ValidationMinIntervalSec * ProtocolTiming.MsPerSecond,
        "zero-supply probe did not pass its minimum interval gate"
      )
      Assert.strictEqual(after.supply, before.supply)
      if (test === ValidationCase.zeroSupply) {
        Assert.deepStrictEqual(after.config, {
          ...before.config,
          min_interval_sec: HeldIntervalSec
        })
      } else
        Assert.deepStrictEqual(
          after.config,
          ctx.outputs.assert(ZeroSupplyConfigKey)
        )
      Assert.strictEqual(
        BigInt(after.pool.supply_snapshot),
        test === ValidationCase.zeroSupply ? 0n : before.supply
      )
      Assert.ok(lastKickMicros(after.pool) > lastKickMicros(before.pool))
      Assert.strictEqual(
        WireClient.chainTimeMs(after.pool.last_kick),
        WireClient.chainTimeMs(response.processed.block_time)
      )
      Assert.strictEqual(BigInt(after.pool.shortfall_amount), 0n)
      Assert.strictEqual(WireClient.chainTimeMs(after.pool.shortfall_time), 0)
      Assert.strictEqual(after.pool.gift_overflow, false)
      Assert.strictEqual(after.pool.spot_deviation, false)
      Assert.deepStrictEqual(
        after.pool.price_snapshot,
        before.pool.price_snapshot
      )
      Assert.strictEqual(after.pool.price_time, before.pool.price_time)
    } else if (test !== ValidationCase.warmupSetup) {
      Assert.strictEqual(
        after.pool.supply_snapshot,
        before.pool.supply_snapshot
      )
      Assert.strictEqual(after.pool.last_kick, before.pool.last_kick)
      Assert.deepStrictEqual(
        after.pool.price_snapshot,
        before.pool.price_snapshot
      )
      Assert.strictEqual(after.pool.price_time, before.pool.price_time)
    } else {
      Assert.strictEqual(BigInt(after.pool.supply_snapshot), after.supply)
      Assert.strictEqual(after.pool.price_time, after.pool.last_kick)
      Assert.strictEqual(after.pool.spent_today, "0")
    }
  }

  /** Exact partial clock, retained because the table JSON truncates time_point to milliseconds. */
  export const CrankClockKey = outputKey<bigint>(
    "LIQKickerScenario.crankClock",
    "exact pro-rata clock for the next shortfall oracle"
  )

  /** Help result shared by all crank steps. */
  export const CapabilityKey = outputKey<boolean>(
    "LIQKickerScenario.capability",
    "nodeop help lists the kick crank"
  )
  /** Baseline after pool re-registration; its daily cap permits only one payment. */
  export const CrankBaselineKey = outputKey<KickerSnapshot>(
    "LIQKickerScenario.crankBaseline",
    "new observation window and ledgers"
  )

  /**
   * One transaction that makes LIQETH's accrued gift payable, kicks it and restores the
   * minimum: `setpool` to {@link Constants.PayableMinGift}, `kick`, `setpool` back to
   * {@link Constants.RestoredMinGift}, governance signed by `sysio` and the kick by `sysio.kicker`. It is one Step because it
   * is one write: the three actions must be atomic, or a batch operator's crank could
   * pay the interval between them and the flow could not attribute the payment.
   */
  export function planPayableKick<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, PayableKickInput> {
    return ClusterBuildStep.create<C, PayableKickInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "LIQKickerScenario.PayableKickInput",
        lower: setpoolData(Constants.PayableMinGift),
        kick: { sym: Constants.LIQTokenCodename },
        restore: setpoolData(Constants.RestoredMinGift)
      },
      runPayableKick
    )
  }

  /** Named runner — push the three-action transaction and record its {@link KickReceipt}. */
  export async function runPayableKick<C extends ClusterBuildContext>(
    ctx: C,
    input: PayableKickInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const kicker = ctx.wire.getSysioContract(SysioContractName.kicker),
      governance = {
        authorization: Steps.contracts.sysio.kicker.GovernanceAuthorization
      },
      response = await ctx.wire.invokeTransaction(
        kicker.actions.setpool.prepare(input.lower, governance),
        kicker.actions.kick.prepare(input.kick, {
          authorization: WireClient.activeAuthorization(Constants.KickerAccount)
        }),
        kicker.actions.setpool.prepare(input.restore, governance)
      )
    ctx.outputs.set(KickReceiptKey, kickReceipt(response))
  }

  /** Everything the manual kick reads, before its transaction. */
  export const BeforeKickKey = outputKey<KickerSnapshot>(
    "LIQKickerScenario.beforeKick",
    "the kicker, supply, TWAP observation, yield-index and treasury state before the manual kick"
  )
  /** The manual kick's treasury draw and block time. */
  export const KickReceiptKey = outputKey<KickReceipt>(
    "LIQKickerScenario.kickReceipt",
    "the manual kick transaction's treasury draw and block time"
  )
  /** The same state after the manual kick — the crank phase's baseline. */
  export const AfterKickKey = outputKey<KickerSnapshot>(
    "LIQKickerScenario.afterKick",
    "the kicker, supply, TWAP observation, yield-index and treasury state after the manual kick"
  )
}
