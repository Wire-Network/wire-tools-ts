import Assert from "node:assert"
import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import {
  ClusterBuildPhase,
  ClusterBuildStep,
  Report,
  StepExtraRecorder,
  getLogger,
  resolveLatestNonce,
  verifyStep,
  type ClusterBuildParent,
  type ClusterBuildStepOptions,
  type StepInput,
  type SwapScenarioContext
} from "@wireio/cluster-tool"

import {
  buildPayoutRequest,
  buildPhase1Requests,
  buildPhase2Requests,
  classifyEthereumAllLegsSaturation,
  createStressIdentities,
  minimumTargetAmount,
  quoteSwapStressPhase1Targets,
  quoteSwapStressPhase2Targets,
  runEthereumSwapBurst,
  runSolanaSwapBurst,
  type StressIdentities,
  type PhaseSaturationEvidence
} from "../swap-stress/index.js"
import { SwapStressSaturationScenarioConstants as Constants } from "../SwapStressSaturationScenarioConstants.js"
import { SwapStressSaturationScenarioOutputs as Outputs } from "../SwapStressSaturationScenarioOutputs.js"
import { SwapStressSaturationScenarioCampaignSteps as CampaignSteps } from "./SwapStressSaturationScenarioCampaignSteps.js"

const log = getLogger(__filename)

/**
 * The saturation campaign expressed as the orchestration model: one
 * {@link ClusterBuildPhase} per ramp rung, each holding the rung's individual
 * writes and observations as Steps, so the `Report` narrates the campaign
 * instead of hiding it inside a single multi-minute row.
 *
 * The rung curve is static — {@link Constants.Ramp} derives it from the load
 * profile at plan time — so the whole tree is built up-front. Saturation is
 * STICKY across rungs (an endpoint that saturated at rung 2 stays saturated),
 * and once both required Ethereum endpoints are covered the remaining rungs
 * no-op with a Report note rather than submitting more load.
 */
export namespace SwapStressSaturationScenarioRungSteps {
  /** The rung's cross-step vocabulary lives with the other typed outputs. */
  export import RungPhaseSlot = Outputs.RungPhaseSlot
  /** @see SwapStressSaturationScenarioOutputs.RungState */
  export type RungState = Outputs.RungState
  /** @see SwapStressSaturationScenarioOutputs.RungPhaseState */
  export type RungPhaseState = Outputs.RungPhaseState
  /** @see SwapStressSaturationScenarioOutputs.rungStateKey */
  export const rungStateKey = Outputs.rungStateKey

  /** Phase-1 measures the outpost→depot leg; phase-2 the depot→outpost leg. */
  const Phase1Endpoint = DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT
  const Phase2Endpoint = DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM

  /** Depot amounts carry 9 decimals; Ethereum targets are wei. */
  const EthWeiPerDepotUnit = 1_000_000_000n

  /** Both legs a rung must eventually cover for the campaign to succeed. */
  const RequiredEndpoints = [Phase1Endpoint, Phase2Endpoint] as const

  function newPhaseState(endpointName: string): RungPhaseState {
    return {
      startedAtMs: 0,
      baselineIdentity: null,
      baseKeys: [],
      telemetryDegraded: false,
      burst: null,
      payoutRequest: null,
      payoutObservedCount: null,
      payoutFailureReason: null,
      batchOperatorFailureReason: null,
      saturated: false,
      endpointName,
      envelopeCount: 0
    }
  }

  /** The rung record, created on first access within the rung. */
  function rungState<C extends SwapScenarioContext>(
    ctx: C,
    input: RungStepInput
  ): RungState {
    const key = rungStateKey(input.rungIndex),
      existing = ctx.outputs.get(key)
    if (existing !== null) return existing
    const created: RungState = {
      rungIndex: input.rungIndex,
      accountCount: input.accountCount,
      skipped: false,
      identities: null,
      phase1: newPhaseState(DebugOutpostEndpointsType[Phase1Endpoint]),
      phase2: newPhaseState(DebugOutpostEndpointsType[Phase2Endpoint])
    }
    ctx.outputs.set(key, created)
    return created
  }

  /** Identities are deterministic, so each rung recomputes its own prefix. */
  function rungIdentities(state: RungState): StressIdentities {
    if (state.identities === null)
      state.identities = createStressIdentities(state.accountCount)
    return state.identities
  }

  /**
   * Whether every required endpoint already saturated in an EARLIER rung.
   * Saturation is sticky, so once both legs are covered the campaign's goal is
   * met and later rungs have nothing left to prove.
   */
  function alreadySaturated<C extends SwapScenarioContext>(
    ctx: C,
    rungIndex: number
  ): boolean {
    const covered = new Set<string>()
    Array.from({ length: rungIndex }, (_value, index) => index).forEach(
      index => {
        const prior = ctx.outputs.get(rungStateKey(index))
        if (prior === null) return
        ;[prior.phase1, prior.phase2]
          .filter(phase => phase.saturated)
          .forEach(phase => covered.add(phase.endpointName))
      }
    )
    return RequiredEndpoints.every(endpoint =>
      covered.has(DebugOutpostEndpointsType[endpoint])
    )
  }

  /**
   * Mark the rung a no-op when the campaign already met its goal.
   *
   * @returns True when the caller should return without doing work.
   */
  function skipWhenSaturated<C extends SwapScenarioContext>(
    ctx: C,
    state: RungState
  ): boolean {
    if (state.skipped) return true
    if (!alreadySaturated(ctx, state.rungIndex)) return false
    state.skipped = true
    StepExtraRecorder.note(
      "rung skipped — both required Ethereum endpoints already saturated",
      { rungIndex: state.rungIndex, accountCount: state.accountCount }
    )
    return true
  }

  /** Every rung Step carries its rung coordinates as its typed input. */
  export interface RungStepInput extends StepInput {
    readonly kind: "SwapStressSaturationScenarioRungSteps.RungStepInput"
    readonly rungIndex: number
    readonly accountCount: number
    readonly concurrency: number
  }

  function rungInput(
    rungIndex: number,
    accountCount: number
  ): RungStepInput {
    return {
      kind: "SwapStressSaturationScenarioRungSteps.RungStepInput",
      rungIndex,
      accountCount,
      concurrency: Constants.Ramp.Concurrency
    }
  }

  // ── Baseline capture ──────────────────────────────────────────────────────

  /**
   * Capture the pre-phase envelope baseline. MUST precede the burst: the
   * baseline is the set of sidecar keys that already existed, and without it
   * the phase window would count prior envelopes as its own.
   */
  export function planCaptureBaseline<C extends SwapScenarioContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    rungIndex: number,
    accountCount: number,
    slot: RungPhaseSlot
  ): ClusterBuildStep<C, RungStepInput> {
    return ClusterBuildStep.create<C, RungStepInput>(
      actor,
      name,
      description,
      options,
      rungInput(rungIndex, accountCount),
      slot === RungPhaseSlot.phase1
        ? runCaptureBaselinePhase1
        : runCaptureBaselinePhase2
    )
  }

  /** Named runner — phase-1 baseline. */
  export async function runCaptureBaselinePhase1<
    C extends SwapScenarioContext
  >(ctx: C, input: RungStepInput, signal: AbortSignal): Promise<void> {
    await captureBaselineInto(ctx, input, signal, RungPhaseSlot.phase1)
  }

  /** Named runner — phase-2 baseline. */
  export async function runCaptureBaselinePhase2<
    C extends SwapScenarioContext
  >(ctx: C, input: RungStepInput, signal: AbortSignal): Promise<void> {
    await captureBaselineInto(ctx, input, signal, RungPhaseSlot.phase2)
  }

  async function captureBaselineInto<C extends SwapScenarioContext>(
    ctx: C,
    input: RungStepInput,
    signal: AbortSignal,
    slot: RungPhaseSlot
  ): Promise<void> {
    signal.throwIfAborted()
    const state = rungState(ctx, input)
    if (skipWhenSaturated(ctx, state)) return
    const phase = state[slot]
    // Read the clock BEFORE the capture so the correlation window covers the
    // capture poll itself — matching the pre-rewrite phase runner.
    phase.startedAtMs = Date.now()
    const services = await CampaignSteps.campaignServices(ctx),
      captured = await services.captureEnvelopeBaseline()
    if (captured.kind !== "captured") {
      phase.telemetryDegraded = true
      StepExtraRecorder.note("envelope baseline capture degraded", {
        rungIndex: state.rungIndex,
        slot
      })
      return
    }
    phase.baselineIdentity = captured.baseline.identity
    phase.baseKeys = captured.baseline.baseKeys
    StepExtraRecorder.note("envelope baseline captured", {
      rungIndex: state.rungIndex,
      slot,
      baseKeyCount: captured.baseline.baseKeys.length
    })
  }

  // ── Phase-1 burst (quote + prepare payouts + nonce block + submit) ────────

  /**
   * The phase-1 write Step: quote against the live book, build the per-account
   * `requestSwap` batch, snapshot payout baselines, allocate ONE contiguous
   * nonce block, and submit the bounded burst.
   *
   * Nonce allocation lives in this Step deliberately: `resolveLatestNonce`
   * advances a process-global counter, so allocating in a separate Step (or
   * retrying this one) would permanently skip a nonce range and stall every
   * later transaction from that address.
   */
  export function planPhase1Burst<C extends SwapScenarioContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    rungIndex: number,
    accountCount: number
  ): ClusterBuildStep<C, RungStepInput> {
    return ClusterBuildStep.create<C, RungStepInput>(
      actor,
      name,
      description,
      options,
      rungInput(rungIndex, accountCount),
      runPhase1Burst
    )
  }

  /** Named runner — phase-1 bounded burst. */
  export async function runPhase1Burst<C extends SwapScenarioContext>(
    ctx: C,
    input: RungStepInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const state = rungState(ctx, input)
    if (skipWhenSaturated(ctx, state)) return
    if (state.phase1.telemetryDegraded) return
    const services = await CampaignSteps.campaignServices(ctx),
      identities = rungIdentities(state),
      snapshot = await CampaignSteps.readReservePairSnapshot(ctx),
      targets = quoteSwapStressPhase1Targets(snapshot, identities.wire.length),
      payoutRequest = buildPayoutRequest(
        "phase-1",
        identities.wire.map(identity => ({
          index: identity.index,
          address: identity.account
        })),
        minimumTargetAmount(targets)
      )
    state.phase1.payoutRequest = payoutRequest
    await services.recipientPayoutObserver.preparePayouts?.(payoutRequest)
    const requests = buildPhase1Requests(services.route, identities, targets),
      firstNonce = await resolveLatestNonce(
        services.ethereumReserveManager,
        requests.length
      )
    state.phase1.burst = await runEthereumSwapBurst({
      reserveManager: services.ethereumReserveManager,
      requests,
      firstNonce,
      concurrency: input.concurrency
    })
    StepExtraRecorder.note("phase-1 burst submitted", {
      rungIndex: state.rungIndex,
      requested: requests.length,
      succeeded: state.phase1.burst.successes.length,
      failed: state.phase1.burst.failures.length
    })
  }

  // ── Phase-2 burst ─────────────────────────────────────────────────────────

  /**
   * The phase-2 write Step: re-read the reserve book (phase 1 moved it),
   * re-quote, snapshot the Ethereum-side payout baselines, and submit the
   * `sysio.uwrit::swapfromwire` burst back toward the paired ETH addresses.
   */
  export function planPhase2Burst<C extends SwapScenarioContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    rungIndex: number,
    accountCount: number
  ): ClusterBuildStep<C, RungStepInput> {
    return ClusterBuildStep.create<C, RungStepInput>(
      actor,
      name,
      description,
      options,
      rungInput(rungIndex, accountCount),
      runPhase2Burst
    )
  }

  /** Named runner — phase-2 bounded burst. */
  export async function runPhase2Burst<C extends SwapScenarioContext>(
    ctx: C,
    input: RungStepInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const state = rungState(ctx, input)
    if (skipWhenSaturated(ctx, state)) return
    if (state.phase2.telemetryDegraded) return
    const services = await CampaignSteps.campaignServices(ctx),
      identities = rungIdentities(state),
      snapshot = await CampaignSteps.readReservePairSnapshot(ctx),
      targets = quoteSwapStressPhase2Targets(snapshot, identities.wire.length),
      payoutRequest = buildPayoutRequest(
        "phase-2",
        identities.ethereum.map(identity => ({
          index: identity.index,
          address: identity.address
        })),
        minimumTargetAmount(targets) * EthWeiPerDepotUnit
      )
    state.phase2.payoutRequest = payoutRequest
    await services.returnPayoutObserver.preparePayouts?.(payoutRequest)
    state.phase2.burst = await runSolanaSwapBurst({
      requests: buildPhase2Requests(services.route, identities, targets),
      concurrency: input.concurrency,
      submit: request => CampaignSteps.submitPhase2Swap(ctx, request)
    })
    StepExtraRecorder.note("phase-2 burst submitted", {
      rungIndex: state.rungIndex,
      succeeded: state.phase2.burst.successes.length,
      failed: state.phase2.burst.failures.length
    })
  }

  // ── Payout observation ────────────────────────────────────────────────────

  /**
   * Observe the phase's payouts. A payout failure is RECORDED, never thrown:
   * the pre-rewrite runner deliberately deferred that verdict until after
   * phase 2 ran, so failing here would suppress the phase-2 evidence the
   * sticky saturation accumulator needs.
   */
  export function planObservePayouts<C extends SwapScenarioContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    rungIndex: number,
    accountCount: number,
    slot: RungPhaseSlot
  ): ClusterBuildStep<C, RungStepInput> {
    return ClusterBuildStep.create<C, RungStepInput>(
      actor,
      name,
      description,
      options,
      rungInput(rungIndex, accountCount),
      slot === RungPhaseSlot.phase1
        ? runObservePayoutsPhase1
        : runObservePayoutsPhase2
    )
  }

  /** Named runner — phase-1 payout observation. */
  export async function runObservePayoutsPhase1<
    C extends SwapScenarioContext
  >(ctx: C, input: RungStepInput, signal: AbortSignal): Promise<void> {
    await observePayoutsInto(ctx, input, signal, RungPhaseSlot.phase1)
  }

  /** Named runner — phase-2 payout observation. */
  export async function runObservePayoutsPhase2<
    C extends SwapScenarioContext
  >(ctx: C, input: RungStepInput, signal: AbortSignal): Promise<void> {
    await observePayoutsInto(ctx, input, signal, RungPhaseSlot.phase2)
  }

  async function observePayoutsInto<C extends SwapScenarioContext>(
    ctx: C,
    input: RungStepInput,
    signal: AbortSignal,
    slot: RungPhaseSlot
  ): Promise<void> {
    signal.throwIfAborted()
    const state = rungState(ctx, input)
    if (skipWhenSaturated(ctx, state)) return
    const phase = state[slot]
    // The pre-rewrite runner skips the payout wait entirely when the burst
    // had failures or telemetry degraded — the wait could only time out.
    if (
      phase.telemetryDegraded ||
      phase.payoutRequest === null ||
      phase.burst === null ||
      phase.burst.failures.length > 0
    )
      return
    const services = await CampaignSteps.campaignServices(ctx),
      observer =
        slot === RungPhaseSlot.phase1
          ? services.recipientPayoutObserver
          : services.returnPayoutObserver
    try {
      const payout = await observer.waitForPayouts(phase.payoutRequest)
      phase.payoutObservedCount = payout.observedCount
      StepExtraRecorder.note("payouts observed", {
        rungIndex: state.rungIndex,
        slot,
        observedCount: payout.observedCount,
        expectedCount: phase.payoutRequest.expectedCount
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      phase.payoutFailureReason = reason
      phase.batchOperatorFailureReason = CampaignSteps.findBatchOperatorFailure(
        ctx.config,
        phase.startedAtMs,
        Date.now()
      )
      log.warn(
        `[SwapStressSaturation] rung ${state.rungIndex} ${slot} payout observation failed: ${reason}`
      )
      StepExtraRecorder.note("payout observation failed", {
        rungIndex: state.rungIndex,
        slot,
        reason,
        batchOperatorFailureReason: phase.batchOperatorFailureReason
      })
    }
  }

  // ── Metric collection ─────────────────────────────────────────────────────

  /**
   * Project the phase's OPP envelopes into saturation metrics.
   *
   * The window is asymmetric by design, preserving the pre-rewrite runner:
   * phase-1 measures burst-only (collected before its payout wait), phase-2
   * measures burst + payout wait (collected after).
   */
  export function planCollectMetrics<C extends SwapScenarioContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    rungIndex: number,
    accountCount: number,
    slot: RungPhaseSlot
  ): ClusterBuildStep<C, RungStepInput> {
    return ClusterBuildStep.create<C, RungStepInput>(
      actor,
      name,
      description,
      options,
      rungInput(rungIndex, accountCount),
      slot === RungPhaseSlot.phase1
        ? runCollectMetricsPhase1
        : runCollectMetricsPhase2
    )
  }

  /** Named runner — phase-1 metrics (window ends at the burst). */
  export async function runCollectMetricsPhase1<
    C extends SwapScenarioContext
  >(ctx: C, input: RungStepInput, signal: AbortSignal): Promise<void> {
    await collectMetricsInto(
      ctx,
      input,
      signal,
      RungPhaseSlot.phase1,
      Phase1Endpoint
    )
  }

  /** Named runner — phase-2 metrics (window spans the payout wait). */
  export async function runCollectMetricsPhase2<
    C extends SwapScenarioContext
  >(ctx: C, input: RungStepInput, signal: AbortSignal): Promise<void> {
    await collectMetricsInto(
      ctx,
      input,
      signal,
      RungPhaseSlot.phase2,
      Phase2Endpoint
    )
  }

  async function collectMetricsInto<C extends SwapScenarioContext>(
    ctx: C,
    input: RungStepInput,
    signal: AbortSignal,
    slot: RungPhaseSlot,
    endpointsType: DebugOutpostEndpointsType
  ): Promise<void> {
    signal.throwIfAborted()
    const state = rungState(ctx, input)
    if (skipWhenSaturated(ctx, state)) return
    const phase = state[slot]
    if (phase.telemetryDegraded || phase.baselineIdentity === null) return
    const services = await CampaignSteps.campaignServices(ctx),
      collected = await services.collectEnvelopeMetrics({
        phase: slot === RungPhaseSlot.phase1 ? "phase-1" : "phase-2",
        endpointsType,
        startedAtMs: phase.startedAtMs,
        endedAtMs: Date.now(),
        baseline: {
          identity: phase.baselineIdentity,
          baseKeys: phase.baseKeys
        }
      })
    if (collected.kind === "degraded") {
      phase.telemetryDegraded = true
      StepExtraRecorder.note("metric collection degraded", {
        rungIndex: state.rungIndex,
        slot
      })
      return
    }
    if (collected.kind !== "measured") {
      StepExtraRecorder.note("metric collection still pending at deadline", {
        rungIndex: state.rungIndex,
        slot
      })
      return
    }
    phase.saturated = collected.metrics.saturated
    phase.envelopeCount = collected.metrics.envelopeCount
    StepExtraRecorder.note("phase metrics collected", {
      rungIndex: state.rungIndex,
      slot,
      endpoint: phase.endpointName,
      saturated: phase.saturated,
      envelopeCount: phase.envelopeCount,
      byteSizes: collected.metrics.envelopeByteSizes
    })
  }

  // ── Per-rung verification ─────────────────────────────────────────────────

  /**
   * Verify runner: the rung's recorded state carries no breakage. Mirrors the
   * pre-rewrite guard order — telemetry degradation, burst failures, payout
   * observation, batch-operator failures — but reads it off the Report-visible
   * per-Step record instead of an opaque in-memory observation.
   */
  export function planVerifyRung<C extends SwapScenarioContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    rungIndex: number,
    accountCount: number
  ): ClusterBuildStep<C, RungStepInput> {
    return ClusterBuildStep.create<C, RungStepInput>(
      actor,
      name,
      description,
      options,
      rungInput(rungIndex, accountCount),
      runVerifyRung
    )
  }

  /** Named runner — assert the rung completed without breakage. */
  export async function runVerifyRung<C extends SwapScenarioContext>(
    ctx: C,
    input: RungStepInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const state = rungState(ctx, input)
    if (state.skipped) return
    const failures = [
      ...phaseFailures("phase-1", state.phase1),
      ...phaseFailures("phase-2", state.phase2)
    ]
    Assert.ok(
      failures.length === 0,
      `rung ${state.rungIndex} (${state.accountCount} accounts) broke:\n  ${failures.join("\n  ")}`
    )
    return Promise.resolve()
  }

  function phaseFailures(
    label: string,
    phase: RungPhaseState
  ): readonly string[] {
    const burstReasons = (phase.burst?.failures ?? []).map(
      failure => `${label} burst failed: ${failure.reason}`
    )
    return [
      ...(phase.telemetryDegraded ? [`${label} OPP telemetry degraded`] : []),
      ...burstReasons,
      ...(phase.batchOperatorFailureReason === null
        ? []
        : [
            `${label} batch operator failure: ${phase.batchOperatorFailureReason}`
          ]),
      ...(phase.payoutFailureReason === null
        ? []
        : [`${label} payout observation failed: ${phase.payoutFailureReason}`]),
      ...(phase.payoutObservedCount !== null && phase.payoutObservedCount < 1
        ? [`${label} payout not observed`]
        : [])
    ]
  }

  // ── Campaign-level verification ───────────────────────────────────────────

  /**
   * Verify runner: BOTH Ethereum OPP directions saturated across the campaign.
   * Saturation is sticky, so this is the union over every rung.
   */
  export async function runVerifyCampaignSaturation<
    C extends SwapScenarioContext
  >(ctx: C, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const results: PhaseSaturationEvidence[] = []
    Constants.Ramp.RungAccountCounts.forEach((accountCount, rungIndex) => {
      const state = ctx.outputs.get(rungStateKey(rungIndex))
      if (state === null) return
      ;[state.phase1, state.phase2].forEach(phase =>
        results.push({
          endpoint: phase.endpointName,
          saturated: phase.saturated
        })
      )
      log.debug(
        `rung ${rungIndex} (${accountCount} accounts): ` +
          `phase1.saturated=${state.phase1.saturated} phase2.saturated=${state.phase2.saturated}`
      )
    })
    const classification = classifyEthereumAllLegsSaturation(results)
    Assert.ok(
      classification.missingEndpoints.length === 0,
      `expected BOTH Ethereum OPP directions to saturate; still missing: ` +
        `[${endpointNames(classification.missingEndpoints)}] ` +
        `(saturated: [${endpointNames(classification.saturatedEndpoints)}])`
    )
    return Promise.resolve()
  }

  /** Endpoint members rendered by NAME — a raw join prints numeric values. */
  function endpointNames(
    endpoints: readonly DebugOutpostEndpointsType[]
  ): string {
    return endpoints
      .map(endpoint => DebugOutpostEndpointsType[endpoint])
      .join(", ")
  }

  // ── The campaign tree ─────────────────────────────────────────────────────

  /**
   * Register the whole campaign: one Phase per ramp rung plus a closing
   * saturation verification.
   *
   * @param parent - The build the campaign registers on.
   * @returns The registered rung phases, in ramp order.
   */
  export function planCampaign<C extends SwapScenarioContext>(
    parent: ClusterBuildParent<C>
  ): readonly ClusterBuildPhase<C>[] {
    const phases = Constants.Ramp.RungAccountCounts.map(
      (accountCount, rungIndex) =>
        planRung<C>(parent, rungIndex, accountCount)
    )
    ClusterBuildPhase.create<C>(
      parent,
      "VerifySaturation",
      "both Ethereum OPP directions saturated across the ramp"
    ).push(
      verifyStep<C>(
        Report.Actor.Sysio,
        "verify-saturation",
        "both Ethereum OPP directions saturated with no missing endpoints",
        runVerifyCampaignSaturation,
        { timeoutMs: Constants.Timing.WriteDeadlineMs }
      )
    )
    return phases
  }

  /**
   * One ramp rung as a Phase of its individual writes and observations.
   *
   * @param parent - The build the phase registers on.
   * @param rungIndex - Zero-based position in the ramp curve.
   * @param accountCount - Stress accounts participating in this rung.
   * @returns The registered phase.
   */
  export function planRung<C extends SwapScenarioContext>(
    parent: ClusterBuildParent<C>,
    rungIndex: number,
    accountCount: number
  ): ClusterBuildPhase<C> {
    // Per-Step ceilings, each sized ABOVE that Step's own inner budget
    // (STYLE.md "Timing Budgets"). A blanket PhaseTimeoutMs is WRONG here: the
    // payout wait polls to PayoutDeadlineMs (a double-hop, 14 min), so a 120s
    // smoke-level ceiling killed it mid-poll on the first live run.
    const captureOptions: ClusterBuildStepOptions = {
        timeoutMs:
          Constants.Timing.RelayDeadlineMs + Constants.Timing.PollDeadlineBufferMs
      },
      burstOptions: ClusterBuildStepOptions = {
        timeoutMs: Constants.Ramp.PhaseTimeoutMs
      },
      payoutOptions: ClusterBuildStepOptions = {
        timeoutMs:
          Constants.Timing.PayoutDeadlineMs + Constants.Timing.PollDeadlineBufferMs
      },
      verifyOptions: ClusterBuildStepOptions = {
        timeoutMs: Constants.Timing.WriteDeadlineMs
      },
      phase = ClusterBuildPhase.create<C>(
        parent,
        `Rung-${accountCount}`,
        `ramp rung ${rungIndex + 1}/${Constants.Ramp.RungAccountCounts.length}: ${accountCount} accounts through both Ethereum OPP directions`
      )
    return phase.push(
      planCaptureBaseline<C>(
        Report.Actor.User,
        `rung-${accountCount}-phase1-baseline`,
        "capture the pre-burst OPP envelope baseline (outpost→depot)",
        captureOptions,
        rungIndex,
        accountCount,
        RungPhaseSlot.phase1
      ),
      planPhase1Burst<C>(
        Report.Actor.User,
        `rung-${accountCount}-phase1-burst`,
        `submit ${accountCount} ETH ReserveManager.requestSwap transactions`,
        burstOptions,
        rungIndex,
        accountCount
      ),
      planCollectMetrics<C>(
        Report.Actor.User,
        `rung-${accountCount}-phase1-metrics`,
        "project outpost→depot envelopes into saturation metrics",
        captureOptions,
        rungIndex,
        accountCount,
        RungPhaseSlot.phase1
      ),
      planObservePayouts<C>(
        Report.Actor.User,
        `rung-${accountCount}-phase1-payouts`,
        "observe the WIRE-side payouts credited by phase 1",
        payoutOptions,
        rungIndex,
        accountCount,
        RungPhaseSlot.phase1
      ),
      planCaptureBaseline<C>(
        Report.Actor.User,
        `rung-${accountCount}-phase2-baseline`,
        "capture the pre-burst OPP envelope baseline (depot→outpost)",
        captureOptions,
        rungIndex,
        accountCount,
        RungPhaseSlot.phase2
      ),
      planPhase2Burst<C>(
        Report.Actor.User,
        `rung-${accountCount}-phase2-burst`,
        `submit ${accountCount} sysio.uwrit::swapfromwire actions`,
        burstOptions,
        rungIndex,
        accountCount
      ),
      planObservePayouts<C>(
        Report.Actor.User,
        `rung-${accountCount}-phase2-payouts`,
        "observe the Ethereum-side payouts credited by phase 2",
        payoutOptions,
        rungIndex,
        accountCount,
        RungPhaseSlot.phase2
      ),
      planCollectMetrics<C>(
        Report.Actor.User,
        `rung-${accountCount}-phase2-metrics`,
        "project depot→outpost envelopes into saturation metrics",
        captureOptions,
        rungIndex,
        accountCount,
        RungPhaseSlot.phase2
      ),
      planVerifyRung<C>(
        Report.Actor.Sysio,
        `rung-${accountCount}-verify`,
        "the rung completed with no burst, payout, or telemetry breakage",
        verifyOptions,
        rungIndex,
        accountCount
      )
    )
  }
}
