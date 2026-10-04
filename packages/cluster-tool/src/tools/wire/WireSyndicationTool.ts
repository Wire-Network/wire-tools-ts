/**
 * WireSyndicationTool — reads of the depot's syndication state (`sysio.synd`,
 * `sysio.bond`, `sysio.andon`, the `sysio.liq` shadow ledger and the
 * `sysio.tokens` registry), and the composites a flow uses to underwrite an
 * envelope: {@link WireSyndicationTool.planBondEnvelope} (bond a request's whole
 * remainder, then verify it is BONDED) and
 * {@link WireSyndicationTool.planApproveAndClaim} (approve after the challenge
 * window, then claim).
 *
 * Every read goes through the typed `getSysioContract(name).tables.<table>`
 * accessor. The KV tables here are keyed by composite keys the accessor does
 * not bound, so each read takes the whole table up to {@link TableRowLimit}
 * rows and filters it; a read that comes back truncated is refused
 * ({@link assertCompleteRead}) rather than trusted, so a row past the limit can
 * never read as absent. The two verify Steps the bootstrap's
 * `SyndicationConfig` phase carries live here too:
 * {@link WireSyndicationTool.planVerifyShadowPrecision} and
 * {@link WireSyndicationTool.planVerifyLiqTokenActive}.
 */

import Assert from "node:assert"

import { identity } from "lodash"
import { match, P } from "ts-pattern"
import { Asset, SlugName, SysioContracts } from "@wireio/sdk-core"

import { ProtocolTiming } from "../../Constants.js"
import { WireClient } from "../../clients/wire/WireClient.js"
import { ClusterBuildContext } from "../../orchestration/ClusterBuildContext.js"
import { ClusterBuildPhase } from "../../orchestration/ClusterBuildPhase.js"
import type { ClusterBuildParent } from "../../orchestration/ClusterBuildPhaseBase.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../orchestration/ClusterBuildStep.js"
import type { OutputKey } from "../../orchestration/OutputStore.js"
import type { StepInput } from "../../orchestration/StepRunner.js"
import { pollUntil } from "../../orchestration/StepTools.js"
import { BondContractSteps } from "../../orchestration/steps/contracts/sysio/BondContractSteps.js"
import { Report } from "../../report/Report.js"
import { matchesProtoEnum } from "../../utils/predicateUtils.js"
import { slugValue } from "../../utils/slugUtils.js"
import { WireReserveTool } from "./WireReserveTool.js"

const {
  SysioContractName,
  SysioContractAccount,
  SysioBondRequestState,
  SysioSyndEnvelopeState,
  SysioSyndRequestOutcome,
  SysioTokensTokenkind
} = SysioContracts

/** Reads of the depot's syndication state, and the underwriting composites flows use. */
export namespace WireSyndicationTool {
  /**
   * Row limit for every whole-table read here. A read that comes back with `more` set is
   * refused ({@link assertCompleteRead}), so raising the rows a flow writes past this limit
   * fails the read loudly instead of hiding a row.
   */
  export const TableRowLimit = 1_000

  /** Key field of the `sysio.liq` tables keyed by a symbol code (`stat`, `liqpending`). */
  export const SymbolKeyField: keyof SysioContracts.SysioLiqSymbolKeyType =
    "symbol_code"

  /**
   * Decimals below a shadow's precision that `sysio.bond` bonds in: it moves in steps of
   * `10^(precision - 2)` base units (0.01 token) and refuses a token of precision below 2
   * (`sysio.bond.hpp` `BOND_INCREMENT_DECIMALS`).
   */
  export const BondIncrementDecimals = 2

  /**
   * How long {@link runAcceptRemainder} waits for the envelope's request to be issued (ms):
   * the envelope crosses one hop to the depot, and `closeenv`'s inline queue step issues
   * the request in the same transaction.
   */
  export const RequestIssuedBudgetMs = ProtocolTiming.SingleHopBudgetMs

  /** Gap between {@link runAcceptRemainder}'s envelope reads (ms). */
  export const RequestIssuedPollIntervalMs = 1_000

  /** Suffix of the verify Step's name in {@link planBondEnvelope}. */
  export const BondedVerifyStepSuffix = "-bonded"

  /** Suffix of the claim Step's name in {@link planApproveAndClaim}. */
  export const ClaimStepSuffix = "-claim"

  // ── reads: sysio.synd ────────────────────────────────────────────────────

  /**
   * READ every `sysio.synd::envelopes` row of one `(outpost, token)` pair, in table order
   * (oldest depot epoch first).
   *
   * @param chainCode - The outpost chain's codename (`SOLANA`).
   * @param tokenCode - The liq token's codename (`LIQSOL`).
   */
  export async function readEnvelopes<C extends ClusterBuildContext>(
    ctx: C,
    chainCode: string,
    tokenCode: string
  ): Promise<SysioContracts.SysioSyndEnvelopeRowType[]> {
    const result = await ctx.wire
      .getSysioContract(SysioContractName.synd)
      .tables.envelopes.query({ limit: TableRowLimit })
    assertCompleteRead(result.more, SysioContractName.synd, "envelopes")
    return result.rows.filter(row => isPair(row, chainCode, tokenCode))
  }

  /**
   * READ the `sysio.synd::envelopes` row of one pair at one depot epoch; nothing when the
   * depot has not seen a syndication or yield report of the pair in that epoch.
   */
  export async function readEnvelope<C extends ClusterBuildContext>(
    ctx: C,
    chainCode: string,
    tokenCode: string,
    epochIndex: number
  ): Promise<SysioContracts.SysioSyndEnvelopeRowType> {
    return (await readEnvelopes(ctx, chainCode, tokenCode)).find(
      row => row.epoch_index === epochIndex
    )
  }

  /** READ the `sysio.synd::items` rows held in one envelope, in id (arrival) order. */
  export async function readItems<C extends ClusterBuildContext>(
    ctx: C,
    chainCode: string,
    tokenCode: string,
    epochIndex: number
  ): Promise<SysioContracts.SysioSyndItemRowType[]> {
    const result = await ctx.wire
      .getSysioContract(SysioContractName.synd)
      .tables.items.query({ limit: TableRowLimit })
    assertCompleteRead(result.more, SysioContractName.synd, "items")
    return result.rows.filter(
      row => isPair(row, chainCode, tokenCode) && row.epoch_index === epochIndex
    )
  }

  /**
   * Find a closed, unbonded envelope holding an exact item. An absent match is
   * returned while the attestation is in flight; truncated reads are refused.
   */
  export async function readHeldEnvelope<C extends ClusterBuildContext>(
    ctx: C,
    chainCode: string,
    tokenCode: string,
    kind: SysioContracts.SysioSyndItemKind,
    amount: bigint,
    pubkey?: string
  ): Promise<SysioContracts.SysioSyndEnvelopeRowType> {
    const result = await ctx.wire
      .getSysioContract(SysioContractName.synd)
      .tables.items.query({ limit: TableRowLimit })
    assertCompleteRead(result.more, SysioContractName.synd, "items")
    const item = result.rows.find(
      row =>
        isPair(row, chainCode, tokenCode) &&
        matchesProtoEnum(row.kind, SysioContracts.SysioSyndItemKind, kind) &&
        BigInt(row.amount) === amount &&
        BigInt(row.remaining) === amount &&
        (pubkey == null || row.pubkey === pubkey)
    )
    if (item == null) return undefined
    const envelope = await readEnvelope(
      ctx,
      chainCode,
      tokenCode,
      item.epoch_index
    )
    return envelope != null &&
      [SysioSyndEnvelopeState.WAITING, SysioSyndEnvelopeState.REQUESTED].some(
        state => matchesProtoEnum(envelope.state, SysioSyndEnvelopeState, state)
      )
      ? envelope
      : undefined
  }

  /** Plan the final solvency checkpoint shared by syndication flows. */
  export function planVerifyHealthy<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C> {
    return ClusterBuildStep.create<C>(
      actor,
      name,
      description,
      options,
      null,
      runVerifyHealthy
    )
  }

  /** Assert that no solvency check pulled the cord or recorded a mismatch. */
  export async function runVerifyHealthy<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    Assert.ok(
      !(await readCord(ctx))?.pulled,
      "syndication pulled the emergency cord"
    )
    Assert.deepStrictEqual(
      await readMismatches(ctx),
      [],
      "syndication custody mismatch"
    )
  }

  /** READ the `sysio.synd::ledger` row of one pair: its queue cursors and retained-epoch floor. */
  export async function readLedger<C extends ClusterBuildContext>(
    ctx: C,
    chainCode: string,
    tokenCode: string
  ): Promise<SysioContracts.SysioSyndLedgerRowType> {
    const result = await ctx.wire
      .getSysioContract(SysioContractName.synd)
      .tables.ledger.query({ limit: TableRowLimit })
    assertCompleteRead(result.more, SysioContractName.synd, "ledger")
    return result.rows.find(row => isPair(row, chainCode, tokenCode))
  }

  /**
   * READ one direction's `sysio.synd::buckets` row of a pair; nothing before the bucket's
   * first tick (a new bucket starts full).
   */
  export async function readBucket<C extends ClusterBuildContext>(
    ctx: C,
    chainCode: string,
    tokenCode: string,
    direction: SysioContracts.SysioSyndBucketDirection
  ): Promise<SysioContracts.SysioSyndBucketRowType> {
    const result = await ctx.wire
      .getSysioContract(SysioContractName.synd)
      .tables.buckets.query({ limit: TableRowLimit })
    assertCompleteRead(result.more, SysioContractName.synd, "buckets")
    return result.rows.find(
      row =>
        isPair(row, chainCode, tokenCode) &&
        matchesProtoEnum(
          row.direction,
          SysioContracts.SysioSyndBucketDirection,
          direction
        )
    )
  }

  /**
   * READ the `sysio.synd::parked` row a pubkey holds for a token: the shadow delivered to a
   * key that was not linked at release. Nothing when the key has nothing parked.
   *
   * @param pubkey - The key's bytes as hex, as the row carries them.
   */
  export async function readParked<C extends ClusterBuildContext>(
    ctx: C,
    tokenCode: string,
    chainKind: SysioContracts.SysioSyndChainkind,
    pubkey: string
  ): Promise<SysioContracts.SysioSyndParkedRowType> {
    const result = await ctx.wire
      .getSysioContract(SysioContractName.synd)
      .tables.parked.query({ limit: TableRowLimit })
    assertCompleteRead(result.more, SysioContractName.synd, "parked")
    return result.rows.find(
      row =>
        isCode(row.token_code, tokenCode) &&
        matchesProtoEnum(
          row.chain_kind,
          SysioContracts.SysioSyndChainkind,
          chainKind
        ) &&
        row.pubkey === pubkey
    )
  }

  /** READ a token's `sysio.synd::feepot` row: the fees collected; nothing before the first. */
  export async function readFeepot<C extends ClusterBuildContext>(
    ctx: C,
    tokenCode: string
  ): Promise<SysioContracts.SysioSyndFeeRowType> {
    const result = await ctx.wire
      .getSysioContract(SysioContractName.synd)
      .tables.feepot.query({ limit: TableRowLimit })
    assertCompleteRead(result.more, SysioContractName.synd, "feepot")
    return result.rows.find(row => isCode(row.token_code, tokenCode))
  }

  /** READ every `sysio.synd::mismatch` row: the latest active custody incident for each outpost/token pair. */
  export async function readMismatches<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<SysioContracts.SysioSyndMismatchRowType[]> {
    const result = await ctx.wire
      .getSysioContract(SysioContractName.synd)
      .tables.mismatch.query({ limit: TableRowLimit })
    assertCompleteRead(result.more, SysioContractName.synd, "mismatch")
    return result.rows
  }

  /** READ the `sysio.synd::syndconfig` row of one pair; nothing when the pair is unconfigured. */
  export async function readSyndicationConfig<C extends ClusterBuildContext>(
    ctx: C,
    chainCode: string,
    tokenCode: string
  ): Promise<SysioContracts.SysioSyndSyndConfigType> {
    const result = await ctx.wire
      .getSysioContract(SysioContractName.synd)
      .tables.syndconfig.query({ limit: TableRowLimit })
    assertCompleteRead(result.more, SysioContractName.synd, "syndconfig")
    return result.rows.find(row => isPair(row, chainCode, tokenCode))
  }

  // ── reads: sysio.bond ────────────────────────────────────────────────────

  /** READ one `sysio.bond::requests` row; nothing once it is pruned (or before it exists). */
  export async function readRequest<C extends ClusterBuildContext>(
    ctx: C,
    requestId: SysioContracts.SysioBondRequestRowType["id"]
  ): Promise<SysioContracts.SysioBondRequestRowType> {
    const result = await ctx.wire
      .getSysioContract(SysioContractName.bond)
      .tables.requests.query({ limit: TableRowLimit })
    assertCompleteRead(result.more, SysioContractName.bond, "requests")
    return result.rows.find(row => BigInt(row.id) === BigInt(requestId))
  }

  /** READ every `sysio.bond::bonds` row of one request: one per underwriter. */
  export async function readBonds<C extends ClusterBuildContext>(
    ctx: C,
    requestId: SysioContracts.SysioBondBondRowType["request_id"]
  ): Promise<SysioContracts.SysioBondBondRowType[]> {
    const result = await ctx.wire
      .getSysioContract(SysioContractName.bond)
      .tables.bonds.query({ limit: TableRowLimit })
    assertCompleteRead(result.more, SysioContractName.bond, "bonds")
    return result.rows.filter(
      row => BigInt(row.request_id) === BigInt(requestId)
    )
  }

  // ── reads: sysio.andon ───────────────────────────────────────────────────

  /**
   * READ the `sysio.andon::cord` singleton; nothing until the cord is first pulled — the
   * contract reads an absent row as clear.
   */
  export async function readCord<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<SysioContracts.SysioAndonCordStateType> {
    const { rows } = await ctx.wire
      .getSysioContract(SysioContractName.andon)
      .tables.cord.query({ limit: SingletonRowLimit })
    return rows[0]
  }

  /** READ the `sysio.andon::andonconfig` singleton (panic account, pullers); nothing before `setpanic`. */
  export async function readAndonConfig<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<SysioContracts.SysioAndonAndonConfigType> {
    const { rows } = await ctx.wire
      .getSysioContract(SysioContractName.andon)
      .tables.andonconfig.query({ limit: SingletonRowLimit })
    return rows[0]
  }

  // ── reads: the sysio.liq shadow ledger and the sysio.tokens registry ─────

  /**
   * READ a shadow's `sysio.liq::stat` row.
   *
   * @param symbolCode - The shadow's symbol code (`LIQSOL`).
   * @throws If the shadow was never opened.
   */
  export async function readShadowStat<C extends ClusterBuildContext>(
    ctx: C,
    symbolCode: string
  ): Promise<SysioContracts.SysioLiqCurrencyStatsType> {
    const { rows } = await ctx.wire
      .getSysioContract(SysioContractName.liq)
      .tables.stat.query({
        ...WireClient.symbolCodeKeyRange(SymbolKeyField, symbolCode),
        limit: SingletonRowLimit
      })
    Assert.ok(
      rows.length === 1,
      `WireSyndicationTool: sysio.liq::stat has no ${symbolCode} row — the shadow was never opened`
    )
    return rows[0]
  }

  /**
   * READ a shadow's outstanding (base units): its `sysio.liq` supply plus the yield parked
   * in `liqpending` — the same figure as the contract's `liq::outstanding_of`, the one an
   * outpost's custody must cover.
   *
   * @param symbolCode - The shadow's symbol code (`LIQSOL`).
   */
  export async function readOutstanding<C extends ClusterBuildContext>(
    ctx: C,
    symbolCode: string
  ): Promise<bigint> {
    const stat = await readShadowStat(ctx, symbolCode),
      { rows } = await ctx.wire
        .getSysioContract(SysioContractName.liq)
        .tables.liqpending.query({
          ...WireClient.symbolCodeKeyRange(SymbolKeyField, symbolCode),
          limit: SingletonRowLimit
        }),
      pending = rows.length === 0 ? 0n : assetUnits(rows[0].quantity)
    return assetUnits(stat.supply) + pending
  }

  /** READ a token's `sysio.tokens::tokens` registry row; nothing when it is not registered. */
  export async function readToken<C extends ClusterBuildContext>(
    ctx: C,
    tokenCode: string
  ): Promise<SysioContracts.SysioTokensTokenRowType> {
    const result = await ctx.wire
      .getSysioContract(SysioContractName.tokens)
      .tables.tokens.query({ limit: TableRowLimit })
    assertCompleteRead(result.more, SysioContractName.tokens, "tokens")
    return result.rows.find(row => isCode(row.code, tokenCode))
  }

  /** READ a `sysio.tokens::chaintokens` binding row; nothing when the pair is not bound. */
  export async function readChainToken<C extends ClusterBuildContext>(
    ctx: C,
    chainCode: string,
    tokenCode: string
  ): Promise<SysioContracts.SysioTokensChainTokenRowType> {
    const result = await ctx.wire
      .getSysioContract(SysioContractName.tokens)
      .tables.chaintokens.query({ limit: TableRowLimit })
    assertCompleteRead(result.more, SysioContractName.tokens, "chaintokens")
    return result.rows.find(row => isPair(row, chainCode, tokenCode))
  }

  // ── composite: bond an envelope's request ────────────────────────────────

  /**
   * The depot epoch of an envelope: the index itself when the flow knows it while
   * planning, or the {@link OutputKey} an earlier Step stores it under when the flow
   * learns it only at run time (the epoch the depot accepted the envelope in).
   */
  export type EnvelopeEpoch = number | OutputKey<number>

  /**
   * The epoch index an {@link EnvelopeEpoch} names: the number itself, or the value an
   * earlier Step stored under the key.
   *
   * @throws If the key holds no value yet.
   */
  export function resolveEnvelopeEpoch<C extends ClusterBuildContext>(
    ctx: C,
    epoch: EnvelopeEpoch
  ): number {
    return match(epoch)
      .with(P.number, identity)
      .with({ name: P.string }, key => ctx.outputs.assert(key))
      .exhaustive()
  }

  /** How an {@link EnvelopeEpoch} reads in a Step description. */
  export function describeEnvelopeEpoch(epoch: EnvelopeEpoch): string {
    return match(epoch)
      .with(P.number, index => `epoch ${index}`)
      .with({ name: P.string }, key => `the epoch in ${key.name}`)
      .exhaustive()
  }

  /** Input for the accept Step {@link planBondEnvelope} composes. */
  export interface AcceptRemainderInput extends StepInput {
    readonly kind: "WireSyndicationTool.AcceptRemainderInput"
    /** The underwriter's on-chain account; it signs `accept` and must hold the shadow. */
    readonly bonderAccount: string
    /** The outpost chain's codename (`SOLANA`). */
    readonly chainCode: string
    /** The liq token's codename (`LIQSOL`). */
    readonly tokenCode: string
    /** The depot epoch of the envelope, or the output an earlier Step records it under. */
    readonly epoch: EnvelopeEpoch
  }

  /** Input for the verify Step {@link planBondEnvelope} composes. */
  export interface VerifyBondedInput extends StepInput {
    readonly kind: "WireSyndicationTool.VerifyBondedInput"
    /** The outpost chain's codename. */
    readonly chainCode: string
    /** The liq token's codename. */
    readonly tokenCode: string
    /** The depot epoch of the envelope, or the output an earlier Step records it under. */
    readonly epoch: EnvelopeEpoch
  }

  /**
   * Underwrite one envelope: ONE Phase of two Steps — `sysio.bond::accept` of the whole
   * remainder of the envelope's request, signed by `bonderAccount`
   * ({@link runAcceptRemainder}), then a verify that the request is BONDED
   * ({@link runVerifyBonded}). Self-registers on `parent`.
   *
   * @param parent - The build root or enclosing PhaseGroup.
   * @param name - Phase name; the Steps are `<name>` and `<name>-bonded`.
   * @param description - Human-readable phase description.
   * @param options - Step option overrides for both Steps (size `timeoutMs` above
   *   {@link RequestIssuedBudgetMs} when the envelope may still be in flight).
   * @param bonderAccount - The underwriter's on-chain account.
   * @param chainCode - The outpost chain's codename.
   * @param tokenCode - The liq token's codename.
   * @param epoch - The depot epoch of the envelope, or the key an earlier Step of the
   *   flow stores it under.
   * @returns The self-registered Phase.
   */
  export function planBondEnvelope<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    parent: ClusterBuildParent<C>,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    bonderAccount: string,
    chainCode: string,
    tokenCode: string,
    epoch: EnvelopeEpoch
  ): ClusterBuildPhase<C> {
    const envelopeLabel = `${chainCode}/${tokenCode} ${describeEnvelopeEpoch(epoch)}`
    return ClusterBuildPhase.create<C>(parent, name, description, [
      ClusterBuildStep.create<C, AcceptRemainderInput>(
        Report.Actor.Underwriter,
        name,
        `${bonderAccount} bonds the whole remainder of the ${envelopeLabel} request`,
        options,
        {
          kind: "WireSyndicationTool.AcceptRemainderInput",
          bonderAccount,
          chainCode,
          tokenCode,
          epoch
        },
        runAcceptRemainder
      ),
      ClusterBuildStep.create<C, VerifyBondedInput>(
        Report.Actor.Sysio,
        `${name}${BondedVerifyStepSuffix}`,
        `the ${envelopeLabel} request is BONDED`,
        options,
        {
          kind: "WireSyndicationTool.VerifyBondedInput",
          chainCode,
          tokenCode,
          epoch
        },
        runVerifyBonded
      )
    ])
  }

  /**
   * Named runner — wait for the envelope's request to be issued, read what it still needs,
   * and delegate ONE `accept` of that remainder to `BondContractSteps.runAccept`.
   *
   * @throws If the request is not issued within {@link RequestIssuedBudgetMs}, or is
   *   already fully bonded.
   */
  export async function runAcceptRemainder<C extends ClusterBuildContext>(
    ctx: C,
    input: AcceptRemainderInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const { chainCode, tokenCode } = input,
      epochIndex = resolveEnvelopeEpoch(ctx, input.epoch),
      label = `${chainCode}/${tokenCode} epoch ${epochIndex}`
    await pollUntil(
      `the ${label} envelope's sysio.bond request is issued`,
      async () =>
        isRequestIssued(
          await readEnvelope(ctx, chainCode, tokenCode, epochIndex)
        ),
      RequestIssuedBudgetMs,
      RequestIssuedPollIntervalMs
    )
    const envelope = await readEnvelope(ctx, chainCode, tokenCode, epochIndex),
      request = await readRequest(ctx, envelope.request_id)
    Assert.ok(
      request != null,
      `WireSyndicationTool: the ${label} envelope names request ${envelope.request_id}, which sysio.bond does not hold`
    )
    const remainder = BigInt(request.covered) - BigInt(request.bonded)
    Assert.ok(
      remainder > 0n,
      `WireSyndicationTool: request ${request.id} of the ${label} envelope is already fully bonded`
    )
    await BondContractSteps.runAccept(
      ctx,
      {
        kind: "BondContractSteps.AcceptInput",
        data: {
          underwriter: input.bonderAccount,
          request_id: envelope.request_id,
          amount: remainder.toString()
        }
      },
      signal
    )
  }

  /** Named runner — assert the envelope's request reads BONDED on `sysio.bond`. */
  export async function runVerifyBonded<C extends ClusterBuildContext>(
    ctx: C,
    input: VerifyBondedInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const { chainCode, tokenCode } = input,
      epochIndex = resolveEnvelopeEpoch(ctx, input.epoch),
      label = `${chainCode}/${tokenCode} epoch ${epochIndex}`,
      envelope = await readEnvelope(ctx, chainCode, tokenCode, epochIndex)
    Assert.ok(
      isRequestIssued(envelope),
      `WireSyndicationTool: the ${label} envelope has no issued sysio.bond request`
    )
    const request = await readRequest(ctx, envelope.request_id)
    Assert.ok(
      request != null &&
        matchesProtoEnum(
          request.state,
          SysioBondRequestState,
          SysioBondRequestState.BONDED
        ),
      `WireSyndicationTool: request ${envelope.request_id} of the ${label} envelope is ` +
        `${request == null ? "absent" : String(request.state)}, expected BONDED`
    )
  }

  /** Explicit governance shortcut for a known envelope, never an implicit bond fallback. */
  export interface ResolveEnvelopeInput extends StepInput {
    readonly kind: "WireSyndicationTool.ResolveEnvelopeInput"
    readonly chainCode: string
    readonly tokenCode: string
    readonly epoch: EnvelopeEpoch
  }

  /** Plan ONE sysio-authorized VALID ruling; callers still crank and verify wallet delivery. */
  export function planResolveEnvelope<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    chainCode: string,
    tokenCode: string,
    epoch: EnvelopeEpoch
  ): ClusterBuildStep<C, ResolveEnvelopeInput> {
    return ClusterBuildStep.create<C, ResolveEnvelopeInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "WireSyndicationTool.ResolveEnvelopeInput",
        chainCode,
        tokenCode,
        epoch
      },
      runResolveEnvelope
    )
  }

  /** Resolve only an OPEN request. Never override a challenge, invalidation or provider bond. */
  export async function runResolveEnvelope<C extends ClusterBuildContext>(
    ctx: C,
    input: ResolveEnvelopeInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const epoch = resolveEnvelopeEpoch(ctx, input.epoch)
    await pollUntil(
      "governance settlement request is issued",
      async () => {
        signal.throwIfAborted()
        return isRequestIssued(
          await readEnvelope(ctx, input.chainCode, input.tokenCode, epoch)
        )
      },
      RequestIssuedBudgetMs,
      RequestIssuedPollIntervalMs
    )
    const envelope = await readEnvelope(
        ctx,
        input.chainCode,
        input.tokenCode,
        epoch
      ),
      request = await readRequest(ctx, envelope.request_id)
    Assert.ok(request, "missing governance settlement request")
    // Two deposits can share an envelope; its prior explicit ruling is sufficient.
    if (
      matchesProtoEnum(
        request.state,
        SysioBondRequestState,
        SysioBondRequestState.VALID
      )
    )
      return
    Assert.ok(
      matchesProtoEnum(
        request.state,
        SysioBondRequestState,
        SysioBondRequestState.OPEN
      ),
      "governance settlement requires OPEN; refusing to override provider or challenge state"
    )
    Assert.strictEqual(
      BigInt(request.bonded),
      0n,
      "governance shortcut requires an unbonded request"
    )
    await BondContractSteps.runRslvvalid(
      ctx,
      {
        kind: "BondContractSteps.RslvvalidInput",
        data: { request_id: request.id }
      },
      signal
    )
  }

  // ── composite: approve and claim ─────────────────────────────────────────

  /** Gap between {@link runApproveAfterWindow}'s chain-time reads (ms). */
  export const ApproveWindowPollIntervalMs = 1_000

  /**
   * How long {@link runApproveAfterWindow} waits for a request's challenge window to pass
   * (ms): the window itself, plus {@link ProtocolTiming.PollDeadlineBufferMs} for the head
   * block to cross the deadline and the read to observe it.
   *
   * @param windowSec - The request's `window_sec`.
   */
  export function approveWindowBudgetMs(windowSec: number): number {
    return (
      windowSec * ProtocolTiming.MsPerSecond +
      ProtocolTiming.PollDeadlineBufferMs
    )
  }

  /**
   * When a request's challenge window closes, in epoch ms: `bonded_at + window_sec`, the
   * earliest head-block time at which `sysio.bond::approve` succeeds.
   */
  export function approveOpensAtMs(
    request: SysioContracts.SysioBondRequestRowType
  ): number {
    return (
      WireClient.chainTimeMs(request.bonded_at) +
      request.window_sec * ProtocolTiming.MsPerSecond
    )
  }

  /** A request id known at planning time or captured by an earlier verify Step. */
  export type RequestId =
    | SysioContracts.SysioBondApproveAction["request_id"]
    | OutputKey<SysioContracts.SysioBondApproveAction["request_id"]>

  /** Resolve a runtime request id, refusing an output that has not been recorded. */
  export function resolveRequestId<C extends ClusterBuildContext>(
    ctx: C,
    requestId: RequestId
  ): SysioContracts.SysioBondApproveAction["request_id"] {
    return match(requestId)
      .with(P.number, identity)
      .with(P.string, identity)
      .with({ name: P.string }, key => ctx.outputs.assert(key))
      .exhaustive()
  }

  /** Input to the claim Step with a runtime request id. */
  export interface ClaimRequestInput extends StepInput {
    readonly kind: "WireSyndicationTool.ClaimRequestInput"
    readonly account: string
    readonly requestId: RequestId
  }

  /** Resolve the request and perform ONE claim, signed by its beneficiary. */
  export async function runClaimRequest<C extends ClusterBuildContext>(
    ctx: C,
    input: ClaimRequestInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await BondContractSteps.runClaim(
      ctx,
      {
        kind: "BondContractSteps.ClaimInput",
        data: {
          request_id: resolveRequestId(ctx, input.requestId),
          account: input.account
        },
        signer: input.account
      },
      signal
    )
  }

  /** Input for the approve Step {@link planApproveAndClaim} composes. */
  export interface ApproveAfterWindowInput extends StepInput {
    readonly kind: "WireSyndicationTool.ApproveAfterWindowInput"
    /** The account that signs `approve` (it only foots the CPU). */
    readonly account: string
    /** The `sysio.bond` request. */
    readonly requestId: RequestId
  }

  /**
   * Close a bonded request: ONE Phase of two Steps — `sysio.bond::approve`, sent once the
   * request's challenge window has passed ({@link runApproveAfterWindow}), then
   * `sysio.bond::claim` of the request-token entitlement owed to `account`. Earned WIRE
   * is banked separately for `sysio.bond::claimwire`. Both actions here are permissionless;
   * `account` signs them. Self-registers on `parent`.
   *
   * @param parent - The build root or enclosing PhaseGroup.
   * @param name - Phase name; the Steps are `<name>` and `<name>-claim`.
   * @param description - Human-readable phase description.
   * @param options - Step option overrides for both Steps (size the approve Step's
   *   `timeoutMs` above {@link approveWindowBudgetMs} of the request's window).
   * @param account - The account paid by the claim, which signs both actions.
   * @param requestId - The `sysio.bond` request.
   * @returns The self-registered Phase.
   */
  export function planApproveAndClaim<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    parent: ClusterBuildParent<C>,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    account: string,
    requestId: RequestId
  ): ClusterBuildPhase<C> {
    return ClusterBuildPhase.create<C>(parent, name, description, [
      ClusterBuildStep.create<C, ApproveAfterWindowInput>(
        Report.Actor.Underwriter,
        name,
        `approve request ${requestId} once its challenge window has passed`,
        options,
        {
          kind: "WireSyndicationTool.ApproveAfterWindowInput",
          account,
          requestId
        },
        runApproveAfterWindow
      ),
      ClusterBuildStep.create<C, ClaimRequestInput>(
        Report.Actor.Underwriter,
        `${name}${ClaimStepSuffix}`,
        `pay ${account} what request ${requestId} owes it`,
        options,
        { kind: "WireSyndicationTool.ClaimRequestInput", account, requestId },
        runClaimRequest
      )
    ])
  }

  /**
   * Named runner — read the request, wait until the head block is past its challenge
   * window ({@link approveOpensAtMs}, under {@link approveWindowBudgetMs}), then delegate
   * ONE `approve` to `BondContractSteps.runApprove`. The contract refuses an `approve`
   * inside the window, so sending it early fails the Step for no reason.
   *
   * @throws If the request is absent or not BONDED (held, ruled or already approved), or
   *   the window does not pass within the budget.
   */
  export async function runApproveAfterWindow<C extends ClusterBuildContext>(
    ctx: C,
    input: ApproveAfterWindowInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const { account } = input,
      requestId = resolveRequestId(ctx, input.requestId),
      request = await readRequest(ctx, requestId)
    Assert.ok(
      request != null &&
        matchesProtoEnum(
          request.state,
          SysioBondRequestState,
          SysioBondRequestState.BONDED
        ),
      `WireSyndicationTool: request ${requestId} is ` +
        `${request == null ? "absent" : String(request.state)}; only a BONDED request can be approved`
    )
    const opensAtMs = approveOpensAtMs(request)
    await pollUntil(
      `request ${requestId}'s challenge window passes`,
      async () =>
        WireClient.chainTimeMs((await ctx.wire.getInfo()).head_block_time) >=
        opensAtMs,
      approveWindowBudgetMs(request.window_sec),
      ApproveWindowPollIntervalMs
    )
    await BondContractSteps.runApprove(
      ctx,
      {
        kind: "BondContractSteps.ApproveInput",
        data: { request_id: requestId },
        signer: account
      },
      signal
    )
  }

  // ── verify Steps of the bootstrap's SyndicationConfig phase ──────────────

  /** Input for {@link planVerifyShadowPrecision}. */
  export interface VerifyShadowPrecisionInput extends StepInput {
    readonly kind: "WireSyndicationTool.VerifyShadowPrecisionInput"
    /** The shadow symbol codes to check (`LIQETH`, `LIQSOL`). */
    readonly symbolCodes: readonly string[]
  }

  /**
   * Verify each shadow's `sysio.liq::stat` supply is at the depot frame's precision
   * ({@link WireReserveTool.DepotPrecisionCap}, the frame the Ethereum pool floors its
   * custody to), which is at least {@link BondIncrementDecimals} — below it `sysio.bond`
   * cannot bond the token and every envelope of the pair stalls WAITING.
   */
  export function planVerifyShadowPrecision<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    symbolCodes: readonly string[]
  ): ClusterBuildStep<C, VerifyShadowPrecisionInput> {
    return ClusterBuildStep.create<C, VerifyShadowPrecisionInput>(
      actor,
      name,
      description,
      options,
      { kind: "WireSyndicationTool.VerifyShadowPrecisionInput", symbolCodes },
      runVerifyShadowPrecision
    )
  }

  /** Named runner — read each shadow's `stat` row and assert its precision. */
  export async function runVerifyShadowPrecision<C extends ClusterBuildContext>(
    ctx: C,
    input: VerifyShadowPrecisionInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    Assert.ok(
      WireReserveTool.DepotPrecisionCap >= BondIncrementDecimals,
      `WireSyndicationTool: the depot frame (${WireReserveTool.DepotPrecisionCap}) is below sysio.bond's increment decimals (${BondIncrementDecimals})`
    )
    const precisions = await Promise.all(
      input.symbolCodes.map(async symbolCode => ({
        symbolCode,
        precision: Asset.from((await readShadowStat(ctx, symbolCode)).supply)
          .symbol.precision
      }))
    )
    const wrong = precisions.filter(
      ({ precision }) => precision !== WireReserveTool.DepotPrecisionCap
    )
    Assert.ok(
      wrong.length === 0,
      `WireSyndicationTool: shadow precision must be ${WireReserveTool.DepotPrecisionCap}; got ` +
        wrong
          .map(({ symbolCode, precision }) => `${symbolCode}=${precision}`)
          .join(", ")
    )
  }

  /** Input for {@link planVerifyLiqTokenActive}. */
  export interface VerifyLiqTokenActiveInput extends StepInput {
    readonly kind: "WireSyndicationTool.VerifyLiqTokenActiveInput"
    /** The outpost chain's codename (`ETHEREUM`). */
    readonly chainCode: string
    /** The liq token's codename (`LIQETH`). */
    readonly tokenCode: string
  }

  /**
   * Verify `(chainCode, tokenCode)` is an active TOKEN_KIND_LIQ `sysio.tokens` token bound
   * by an active `chaintokens` row — the condition `sysio.msgch`'s `is_active_liq_token`
   * applies to every `SYNDICATE_LIQ`; without it the depot drops each one.
   */
  export function planVerifyLiqTokenActive<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    chainCode: string,
    tokenCode: string
  ): ClusterBuildStep<C, VerifyLiqTokenActiveInput> {
    return ClusterBuildStep.create<C, VerifyLiqTokenActiveInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "WireSyndicationTool.VerifyLiqTokenActiveInput",
        chainCode,
        tokenCode
      },
      runVerifyLiqTokenActive
    )
  }

  /** Named runner — read the token and its chain binding, and assert both are active. */
  export async function runVerifyLiqTokenActive<C extends ClusterBuildContext>(
    ctx: C,
    input: VerifyLiqTokenActiveInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const { chainCode, tokenCode } = input,
      token = await readToken(ctx, tokenCode)
    Assert.ok(
      token != null &&
        token.active &&
        matchesProtoEnum(
          token.kind,
          SysioTokensTokenkind,
          SysioTokensTokenkind.TOKEN_KIND_LIQ
        ),
      `WireSyndicationTool: ${tokenCode} is not an active TOKEN_KIND_LIQ sysio.tokens token ` +
        `(${token == null ? "unregistered" : `kind=${String(token.kind)} active=${token.active}`})`
    )
    const binding = await readChainToken(ctx, chainCode, tokenCode)
    Assert.ok(
      binding != null && binding.active,
      `WireSyndicationTool: ${chainCode}/${tokenCode} has no active sysio.tokens::chaintokens binding`
    )
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /** Rows a singleton table read asks for. */
  const SingletonRowLimit = 1

  /**
   * Refuse a truncated read: a whole-table read that stops at {@link TableRowLimit} could
   * miss the row it filters for, and report it absent. The table is named by the generated
   * contract surface (`WireClient.TableName`), so a table the ABI does not declare fails to
   * compile.
   *
   * @throws If `more` is set.
   */
  export function assertCompleteRead<
    Name extends SysioContracts.SysioContractName
  >(more: boolean, contract: Name, table: WireClient.TableName<Name>): void {
    Assert.ok(
      !more,
      `WireSyndicationTool: ${SysioContractAccount[contract]}::${table} has more than ${TableRowLimit} rows; the read is truncated`
    )
  }

  /**
   * The envelope states that carry an issued `sysio.bond` request. INVALID is not among
   * them: `dropenv` marks an envelope INVALID before any request (an INVALID ruling of an
   * issued request is told apart by its `outcome`, {@link isRequestIssued}).
   */
  export const RequestIssuedStates = [
    SysioSyndEnvelopeState.REQUESTED,
    SysioSyndEnvelopeState.RELEASABLE,
    SysioSyndEnvelopeState.HELD,
    SysioSyndEnvelopeState.DONE
  ] as const

  /**
   * Whether an envelope row carries an issued `sysio.bond` request, so its `request_id`
   * names a request: a state of {@link RequestIssuedStates}, or INVALID with the ruling
   * recorded as its outcome.
   */
  export function isRequestIssued(
    envelope: SysioContracts.SysioSyndEnvelopeRowType
  ): boolean {
    if (envelope == null) return false
    const inState = (state: SysioContracts.SysioSyndEnvelopeState): boolean =>
      matchesProtoEnum(envelope.state, SysioSyndEnvelopeState, state)
    return (
      RequestIssuedStates.some(inState) ||
      (inState(SysioSyndEnvelopeState.INVALID) &&
        matchesProtoEnum(
          envelope.outcome,
          SysioSyndRequestOutcome,
          SysioSyndRequestOutcome.INVALID
        ))
    )
  }

  /** Whether a slug cell names `codename`. */
  function isCode(cell: string, codename: string): boolean {
    return slugValue(cell) === SlugName.from(codename)
  }

  /** The `(chain_code, token_code)` cells of a pair-keyed row. */
  interface PairCells {
    chain_code: string
    token_code: string
  }

  /** Whether a pair-keyed row belongs to `(chainCode, tokenCode)`. */
  function isPair(
    row: PairCells,
    chainCode: string,
    tokenCode: string
  ): boolean {
    return (
      isCode(row.chain_code, chainCode) && isCode(row.token_code, tokenCode)
    )
  }

  /** The base units of an ABI asset string (`"2.000000000 LIQSOL"` → `2000000000n`). */
  function assetUnits(quantity: string): bigint {
    return BigInt(Asset.from(quantity).units.toString())
  }
}
