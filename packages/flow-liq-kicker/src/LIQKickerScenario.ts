import Assert from "node:assert"
import ChildProcess from "node:child_process"

import { API, Asset, SysioContracts } from "@wireio/sdk-core"
import {
  ClusterBuildPhase,
  ClusterBuildStep,
  FlowScenario,
  ProtocolTiming,
  Report,
  Steps,
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
import { LIQKickerAccrual } from "./LIQKickerAccrual.js"
import { LIQKickerScenarioConstants as Constants } from "./LIQKickerScenarioConstants.js"

const { SysioContractName } = SysioContracts
const { Actor } = Report

// ── reads (execute freely inside runners and verify steps) ──────────────────

/** The base units of an ABI asset string (`"10.000000000 WIRE"` → `10000000000n`). */
function assetUnits(quantity: string): bigint {
  return BigInt(Asset.from(quantity).units.toString())
}

/** The one-row range of a symbol-keyed KV table for `code`. */
function symbolRange(code: string): WireClient.TableQueryArgs {
  return { ...WireClient.symbolCodeKeyRange(Constants.SymbolKeyField, code), limit: 1 }
}

/** `sysio.kicker::kickcfg` — the budget and minimum interval (a read). */
async function readKickerConfig(
  ctx: ClusterBuildContext
): Promise<SysioContracts.SysioKickerKickConfigType> {
  const { rows } = await ctx.wire
    .getSysioContract(SysioContractName.kicker)
    .tables.kickcfg.query({ limit: 1 })
  Assert.ok(rows.length === 1, "sysio.kicker::kickcfg has no row — the bootstrap's Kicker phase never configured it")
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
  Assert.ok(rows.length === 1, `sysio.liq::stat has no ${Constants.LIQTokenCodename} row`)
  return assetUnits(rows[0].supply)
}

/** A LIQ/WIRE pair's two reserves (base units). */
interface PairReserves {
  /** The shadow reserve (`pool1`). */
  readonly poolShadow: bigint
  /** The WIRE reserve (`pool2`). */
  readonly poolWire: bigint
}

/** The flow token's LIQ/WIRE pair reserves on `sysio.swap` — the spot ratio `kick` prices at. */
async function readPairReserves(ctx: ClusterBuildContext): Promise<PairReserves> {
  const { rows } = await ctx.wire
    .getSysioContract(SysioContractName.swap)
    .tables.stat.query(symbolRange(Constants.PairTokenCodename))
  Assert.ok(rows.length === 1, `sysio.swap::stat has no ${Constants.PairTokenCodename} pair`)
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
async function readWireHoldings(ctx: ClusterBuildContext): Promise<KickerWireHoldings> {
  const read = async (): Promise<KickerWireHoldings> => {
      const [treasury, ...buckets] = await Promise.all(
        [Constants.TreasuryAccount, ...Constants.CategoryBucketAccounts].map(account =>
          ctx.wire.getWireBalance(account)
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
  let previous = await read()
  for (;;) {
    const current = await read()
    if (same(previous, current)) return current
    previous = current
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
async function readSnapshot(ctx: ClusterBuildContext): Promise<KickerSnapshot> {
  const [config, pool, supply, reserves, yieldIndex, holdings] = await Promise.all([
    readKickerConfig(ctx),
    readKickerPool(ctx),
    readShadowSupply(ctx),
    readPairReserves(ctx),
    readYieldIndex(ctx),
    readWireHoldings(ctx)
  ])
  return { config, pool, supply, ...reserves, yieldIndex, holdings }
}

/** `last_kick` in microseconds since the epoch (`time_point` JSON has millisecond precision). */
function lastKickMicros(pool: SysioContracts.SysioKickerKickPoolType): bigint {
  return BigInt(WireClient.chainTimeMs(pool.last_kick)) * 1_000n
}

/**
 * The gift the pool pays for `[before.last_kick, after.last_kick]`, priced at the
 * supply and spot ratio both snapshots agree on. Asserts they agree: `kick` reads
 * them at its own block, so a change between the snapshots would make the model's
 * inputs ambiguous.
 */
function expectedGift(before: KickerSnapshot, after: KickerSnapshot): bigint {
  Assert.strictEqual(after.supply, before.supply, "the shadow supply moved across the kick")
  Assert.strictEqual(after.poolWire, before.poolWire, "the pair's WIRE reserve moved across the kick")
  Assert.strictEqual(after.poolShadow, before.poolShadow, "the pair's shadow reserve moved across the kick")
  return LIQKickerAccrual.gift({
    supply: before.supply,
    rateBps: BigInt(before.pool.rate_bps),
    elapsedMicros: lastKickMicros(after.pool) - lastKickMicros(before.pool),
    poolWire: before.poolWire,
    poolShadow: before.poolShadow
  })
}

/**
 * Assert one paid kick moved every ledger by exactly `gift`: the pool's lifetime total
 * and the budget, the shadow's yield index (pot, index and carry), and the treasury —
 * net of any epoch-advance push to the category buckets — while the kicker keeps none.
 */
function assertLedgersMovedBy(before: KickerSnapshot, after: KickerSnapshot, gift: bigint): void {
  Assert.strictEqual(
    BigInt(after.pool.gifted_total) - BigInt(before.pool.gifted_total),
    gift,
    "kickpools.gifted_total did not grow by the gift"
  )
  Assert.strictEqual(
    BigInt(before.config.budget_remaining) - BigInt(after.config.budget_remaining),
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
  Assert.strictEqual(after.holdings.kicker, before.holdings.kicker, "sysio.kicker kept WIRE")
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
interface TransferData {
  readonly from: string
  readonly to: string
  readonly quantity: string
}

/** A trace list flattened, whether the node returned it flat or nested. */
function flattenTraces(traces: ReadonlyArray<ActionTraceView>): ActionTraceView[] {
  return traces.flatMap(trace => [trace, ...flattenTraces(trace.inline_traces ?? [])])
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
export function kickReceipt(response: API.v1.SendTransactionResponse): KickReceipt {
  const draws = flattenTraces(response.processed.action_traces as ActionTraceView[])
    .filter(
      trace =>
        trace.receiver === Constants.TokenAccount &&
        trace.act?.account === Constants.TokenAccount &&
        trace.act.name === Constants.TransferActionName
    )
    .map(trace => trace.act.data as TransferData)
    .filter(
      data => data.from === Constants.TreasuryAccount && data.to === Constants.KickerAccount
    )
  Assert.strictEqual(
    draws.length,
    1,
    `the kick transaction drew ${draws.length} times from ${Constants.TreasuryAccount}; a paid kick draws once`
  )
  return { paid: assetUnits(draws[0].quantity), blockTime: response.processed.block_time }
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
 *    flow's model of the accrual over the paid interval; `last_kick` advances to the
 *    kick's block; the yield index, the budget and the treasury move by exactly the
 *    gift.
 * 3. **CrankKick** — only when the cluster's nodeop carries the batch operators' kick
 *    crank: with the minimum lowered and no kick from the flow, a batch operator pays
 *    the next interval, by the same model; then the minimum is restored.
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
    underwriterCount: Constants.UnderwriterCount
  }

  plan(cluster: ClusterBuild): void {
    const depotWriteStepOptions = { timeoutMs: Constants.DepotWriteTimeoutMs },
      minIntervalStepOptions = {
        timeoutMs: Constants.MinIntervalTimeoutMs + ProtocolTiming.PollDeadlineBufferMs
      },
      crankStepOptions = {
        timeoutMs: Constants.CrankPaymentTimeoutMs + ProtocolTiming.PollDeadlineBufferMs
      }

    // ── 1. The bootstrap's kicker configuration ──
    ClusterBuildPhase.create(
      cluster,
      "KickerConfigured",
      "The bootstrap configured the kicker and LIQETH's pool"
    ).push(
      verifyStep(
        Actor.Sysio,
        "kicker-configured",
        "kickcfg holds the bootstrap's budget and interval; LIQETH's pool is at 200 bps with the one-WIRE minimum and has paid nothing",
        async ctx => {
          const [config, pool] = await Promise.all([readKickerConfig(ctx), readKickerPool(ctx)])
          Assert.deepStrictEqual(
            {
              budget_remaining: BigInt(config.budget_remaining),
              min_interval_sec: config.min_interval_sec
            },
            {
              budget_remaining: BigInt(Steps.registry.KickerConfiguration.cfg.budget_remaining),
              min_interval_sec: Steps.registry.KickerConfiguration.cfg.min_interval_sec
            }
          )
          Assert.strictEqual(pool.rate_bps, Constants.RateBps)
          Assert.strictEqual(BigInt(pool.min_gift), BigInt(Constants.RestoredMinGift))
          Assert.strictEqual(BigInt(pool.gifted_total), 0n)
        }
      )
    )

    // ── 2. A manual kick pays the accrued gift ──
    ClusterBuildPhase.create(
      cluster,
      "ManualKick",
      "After the minimum interval, kick LIQETH and verify the gift against the accrual model"
    ).push(
      verifyStep(
        Actor.Sysio,
        "min-interval-elapsed",
        "the chain clock passes LIQETH's last_kick + min_interval_sec",
        async ctx => {
          const [config, pool] = await Promise.all([readKickerConfig(ctx), readKickerPool(ctx)]),
            dueMs =
              WireClient.chainTimeMs(pool.last_kick) +
              config.min_interval_sec * ProtocolTiming.MsPerSecond
          await pollUntil(
            "chain head past LIQETH's minimum interval",
            async () => WireClient.chainTimeMs((await ctx.wire.getInfo()).head_block_time) > dueMs,
            Constants.MinIntervalTimeoutMs,
            Constants.PollIntervalMs
          )
        },
        minIntervalStepOptions
      ),
      verifyStep(
        Actor.Sysio,
        "snapshot-before-kick",
        "record the pool, budget, supply, spot reserves, yield index and treasury before the kick",
        async ctx => {
          ctx.outputs.set(LIQKickerScenario.BeforeKickKey, await readSnapshot(ctx))
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
        "the paid gift = floor(floor(supply × 200 × elapsed_us / (10^4 × 31,557,600 × 10^6)) × spot) for the paid interval",
        async ctx => {
          const before = ctx.outputs.assert(LIQKickerScenario.BeforeKickKey),
            receipt = ctx.outputs.assert(LIQKickerScenario.KickReceiptKey),
            after = await readSnapshot(ctx),
            expected = expectedGift(before, after)
          ctx.outputs.set(LIQKickerScenario.AfterKickKey, after)
          ctx.log.info(
            `kick(${Constants.LIQTokenCodename}): supply=${before.supply} rate=${before.pool.rate_bps}bps ` +
              `elapsed_us=${lastKickMicros(after.pool) - lastKickMicros(before.pool)} ` +
              `spot=${before.poolWire}/${before.poolShadow} expected=${expected} paid=${receipt.paid}`
          )
          Assert.ok(expected > 0n, "the model expects no gift — the paid interval is empty")
          Assert.strictEqual(receipt.paid, expected, "the kick's treasury draw is not the modelled gift")
          Assert.strictEqual(BigInt(after.pool.shortfall_amount), 0n, "the kick left a shortfall")
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
        async ctx => {
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
        async ctx => {
          assertLedgersMovedBy(
            ctx.outputs.assert(LIQKickerScenario.BeforeKickKey),
            ctx.outputs.assert(LIQKickerScenario.AfterKickKey),
            ctx.outputs.assert(LIQKickerScenario.KickReceiptKey).paid
          )
        }
      )
    )

    // ── 3. The batch operators' crank pays the next interval ──
    const nodeop = cluster.context.config.executables?.nodeop
    if (nodeop != null && LIQKickerScenario.nodeopHasKickCrank(nodeop)) {
      ClusterBuildPhase.create(
        cluster,
        "CrankKick",
        "With LIQETH's minimum lowered and no kick from the flow, a batch operator's crank pays the next interval"
      ).push(
        Steps.contracts.sysio.kicker.planSetpool(
          Actor.Sysio,
          "lower-min-gift",
          "setpool LIQETH to a one-unit minimum so the next due kick pays",
          depotWriteStepOptions,
          setpoolData(Constants.PayableMinGift)
        ),
        verifyStep(
          Actor.BatchOperator,
          "crank-pays-gift",
          "without a kick from the flow, kickpools.gifted_total grows by the modelled gift for the crank's interval",
          async ctx => {
            const before = ctx.outputs.assert(LIQKickerScenario.AfterKickKey)
            await pollUntil(
              "a crank-pushed LIQETH kick pays",
              async () =>
                BigInt((await readKickerPool(ctx)).gifted_total) > BigInt(before.pool.gifted_total),
              Constants.CrankPaymentTimeoutMs,
              Constants.PollIntervalMs
            )
            const after = await readSnapshot(ctx),
              paid = BigInt(after.pool.gifted_total) - BigInt(before.pool.gifted_total),
              expected = expectedGift(before, after)
            ctx.log.info(
              `crank kick(${Constants.LIQTokenCodename}): elapsed_us=` +
                `${lastKickMicros(after.pool) - lastKickMicros(before.pool)} expected=${expected} paid=${paid}`
            )
            Assert.ok(lastKickMicros(after.pool) > lastKickMicros(before.pool), "last_kick did not advance")
            Assert.strictEqual(paid, expected, "the crank's gift is not the modelled gift")
            assertLedgersMovedBy(before, after, paid)
          },
          crankStepOptions
        ),
        Steps.contracts.sysio.kicker.planSetpool(
          Actor.Sysio,
          "restore-min-gift",
          "setpool LIQETH back to the bootstrap's one-WIRE minimum",
          depotWriteStepOptions,
          setpoolData(Constants.RestoredMinGift)
        )
      )
    } else {
      ClusterBuildPhase.create(
        cluster,
        "CrankKickUnavailable",
        "The cluster's nodeop has no kick crank, so no crank-pushed kick is observed"
      ).push(
        verifyStep(
          Actor.BatchOperator,
          "kick-crank-unavailable",
          `nodeop does not register ${Constants.KickCrankOption}; the CrankKick phase is not planned`,
          async ctx => {
            ctx.log.warn(
              `${nodeop ?? "nodeop"} does not register ${Constants.KickCrankOption}: no crank-pushed kick is verified`
            )
          }
        )
      )
    }
  }
}

/** The scenario's step factories, capability probe and typed cross-step outputs. */
export namespace LIQKickerScenario {
  /** Upper bound on `nodeop --help` (ms) — the probe runs once, at plan time. */
  const HelpProbeTimeoutMs = 60_000
  /** `nodeop --help`'s output ceiling (bytes); the full plugin option list is far smaller. */
  const HelpProbeMaxBuffer = 16 * 1024 * 1024

  /**
   * Whether `nodeop` registers the batch operators' kick crank. Spawns
   * `nodeop --help` once; a binary that does not run, or exits non-zero, has none.
   *
   * @param nodeopPath - The cluster's `nodeop` binary.
   * @returns True iff its help lists `--batch-kick-crank`.
   */
  export function nodeopHasKickCrank(nodeopPath: string): boolean {
    const result = ChildProcess.spawnSync(nodeopPath, ["--help"], {
      encoding: "utf8",
      timeout: HelpProbeTimeoutMs,
      maxBuffer: HelpProbeMaxBuffer
    })
    return result.status === 0 && result.stdout.includes(Constants.KickCrankOption)
  }

  /**
   * One transaction that makes LIQETH's accrued gift payable, kicks it and restores the
   * minimum: `setpool` to {@link Constants.PayableMinGift}, `kick`, `setpool` back to
   * {@link Constants.RestoredMinGift}, all signed by `sysio`. It is one Step because it
   * is one write: the three actions must be atomic, or a batch operator's crank could
   * pay the interval between them and the flow could not attribute the payment.
   */
  export function planPayableKick<C extends ClusterBuildContext = ClusterBuildContext>(
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
      governance = { authorization: Steps.contracts.sysio.kicker.GovernanceAuthorization },
      response = await ctx.wire.invokeTransaction(
        kicker.actions.setpool.prepare(input.lower, governance),
        kicker.actions.kick.prepare(input.kick, governance),
        kicker.actions.setpool.prepare(input.restore, governance)
      )
    ctx.outputs.set(KickReceiptKey, kickReceipt(response))
  }

  /** Everything the manual kick reads, before its transaction. */
  export const BeforeKickKey = outputKey<KickerSnapshot>(
    "LIQKickerScenario.beforeKick",
    "the kicker, supply, spot, yield-index and treasury state before the manual kick"
  )
  /** The manual kick's treasury draw and block time. */
  export const KickReceiptKey = outputKey<KickReceipt>(
    "LIQKickerScenario.kickReceipt",
    "the manual kick transaction's treasury draw and block time"
  )
  /** The same state after the manual kick — the crank phase's baseline. */
  export const AfterKickKey = outputKey<KickerSnapshot>(
    "LIQKickerScenario.afterKick",
    "the kicker, supply, spot, yield-index and treasury state after the manual kick"
  )
}
