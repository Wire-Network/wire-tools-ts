import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"

import { SysioContracts } from "@wireio/sdk-core"
import { getLogger } from "@wireio/shared"
import { oppDebuggingPath, parseJsonLogLine, PidSources } from "@wireio/debugging-shared"
import { captureEnvelopeBaseline } from "../envelope-integrity/index.js"
import {
  ClusterBuildStep,
  NodeConfig,
  Report,
  SwapScenarioContext,
  mapSeries,
  pollUntil,
  resolveLatestNonce,
  sleep,
  swapUserOutputKey,
  type ClusterBuildStepOptions,
  type EthereumClient,
  type StepInput,
  type WireClient
} from "@wireio/cluster-tool"
import type { ClusterConfig } from "@wireio/cluster-tool-shared"
import {
  SwapStressRequiredEndpoints,
  classifyOppPhaseMetrics,
  createSwapStressPhaseRunner,
  pollRealFlowBaseline,
  pollRealFlowMetrics,
  runSaturationRamp,
  type Phase2SwapRequest,
  type SolanaBurstRequest,
  type StressRampResult,
  type SwapStressPayoutObservation,
  type SwapStressPayoutObservationRequest,
  type SwapStressPayoutObserver,
  type SwapStressPhaseRunnerDeps,
  type SwapStressRealTelemetryDeps,
  type SwapStressReservePairSnapshot,
  type SwapStressRouteCodes
} from "../swap-stress/index.js"
import {
  RunEvidencePersistence,
  RunEvidenceSchemaVersion,
  RunEvidenceSetupStatus,
  RunEvidenceStage,
  collectOppPhaseMetrics,
  type OppEnvelopeSaturationStrategy,
  type RunEvidenceDecimal
} from "../stress-engine/index.js"
import { SwapStressSaturationScenarioArtifacts as Artifacts } from "../SwapStressSaturationScenarioArtifacts.js"
import { SwapStressSaturationScenarioConstants as Constants } from "../SwapStressSaturationScenarioConstants.js"
import { SwapStressSaturationScenarioOutputs as Outputs } from "../SwapStressSaturationScenarioOutputs.js"

const { SysioContractName, SysioUwritChainkind } = SysioContracts

const log = getLogger(__filename)

/**
 * The ramp campaign — the Phase 2b re-expression of the pre-port
 * `tests/real/realStressRunner + realFlowPayoutObservers + realPhaseTelemetry`
 * drivers as a Report-validated Step: one RunCampaign write-Step whose named
 * runner drives `runSaturationRamp` (per-swap ETH `ReserveManager.requestSwap`
 * phase-1 bursts + `sysio.uwrit::swapfromwire` phase-2 bursts, with delta-based
 * WIRE/ETH payout observers and canonical OPP-envelope telemetry), plus the
 * saturation verify runner the scenario wraps in a `verifyStep`.
 */
export namespace SwapStressSaturationScenarioCampaignSteps {
  /** JSONL log filename prefix emitted by nodeop's daily file appender. */
  export const DailyLogPrefix = "logs_"

  /** Failure fragments emitted by batch_operator_plugin and outpost_opp_job. */
  export const BatchOperatorFailurePatterns: readonly RegExp[] = [
    /outbound delivery failed/,
    /batch_operator: push .* failed/
  ]

  /**
   * Phase-window epoch bounds: the campaign correlates envelopes by wall-clock
   * window + baseline, never by epoch index, so the epoch filter is wide open.
   */
  export const PhaseEpochStart = 0
  /** See {@link PhaseEpochStart}. */
  export const PhaseEpochEnd = Number.MAX_SAFE_INTEGER

  /**
   * Saturation strategy for the campaign's phase metrics. Every current
   * emitter — `sysio.msgch::buildenv` and both outpost emit loops — packs
   * ONE envelope per epoch up to `MAX_ENVELOPE_BYTES` and DEFERS overflow
   * attestations to the next epoch's emit, so a same-epoch second envelope
   * (`epochEnvelopeIndex > 0`, the `rollover` strategy) can never occur. A
   * cap-packed envelope (≥95% of the 64KB cap, `byte_threshold`) is the
   * saturation signal the packing loop actually produces under pressure.
   */
  export const CampaignSaturationStrategy: OppEnvelopeSaturationStrategy =
    "byte_threshold"

  /** Chain label for phase-1 recipient (WIRE depot payout) observations. */
  export const WirePayoutLabel = "WIRE"
  /** Chain label for phase-2 return (native ETH payout) observations. */
  export const EthereumPayoutLabel = "ETH"

  /** Indent used when formatting a ramp result into an assertion message. */
  export const JsonIndent = 2

  // ── Step: RunCampaign (the ramp write-Step) ──────────────────────────────

  /** Input for {@link planRunCampaign} — the persisted ramp shape. */
  export interface RunCampaignInput extends StepInput {
    readonly kind: "SwapStressSaturationScenarioCampaignSteps.RunCampaignInput"
    /** Account count submitted by the first ramp iteration. */
    readonly initialCount: number
    /** Multiplicative account-count increase between iterations. */
    readonly multiplier: number
    /** Inclusive maximum account count allowed by the controller. */
    readonly maxCount: number
    /** Per-phase deadline persisted into run evidence (ms). */
    readonly phaseTimeoutMs: number
    /** Max in-flight swap submissions per burst. */
    readonly concurrency: number
  }

  /**
   * The RunCampaign Step: allocate schema-v1 run evidence, build the
   * dependency-injected `swap-stress` phase runner over the live
   * cluster (clients, deployed `ReserveManager`, OPP debugging artifacts), and
   * drive `runSaturationRamp` until both Ethereum OPP directions saturate,
   * breakage, or the account ceiling. The result lands in `ctx.outputs` under
   * {@link SwapStressSaturationScenarioOutputs.stressRampResult}.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides (carries the campaign ceiling).
   * @returns The definition step.
   */
  export function planRunCampaign<
    C extends SwapScenarioContext = SwapScenarioContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, RunCampaignInput> {
    return ClusterBuildStep.create<C, RunCampaignInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "SwapStressSaturationScenarioCampaignSteps.RunCampaignInput",
        initialCount: Constants.Ramp.InitialCount,
        multiplier: Constants.Ramp.Multiplier,
        maxCount: Constants.Ramp.MaxCount,
        phaseTimeoutMs: Constants.Ramp.PhaseTimeoutMs,
        concurrency: Constants.Ramp.Concurrency
      },
      runRunCampaign
    )
  }

  /**
   * Named runner — allocates run-evidence persistence (the flow's earlier
   * phases ARE the evidence "setup" stage, published as succeeded here), then
   * runs the saturation ramp and stores the result for the verify step.
   */
  export async function runRunCampaign<C extends SwapScenarioContext>(
    ctx: C,
    input: RunCampaignInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const setupStartedAtMs = decimalTimestamp(Date.now()),
      rampConfig = {
        initialCount: input.initialCount,
        multiplier: input.multiplier,
        maxCount: input.maxCount,
        phaseTimeoutMs: input.phaseTimeoutMs
      },
      persistence = await RunEvidencePersistence.allocate({
        clusterPath: ctx.config.clusterPath,
        rampConfig,
        requiredEndpoints: SwapStressRequiredEndpoints,
        provenance: {
          wireBuildPath: ctx.config.buildPath,
          ethereumPath: ctx.config.ethereumPath,
          solanaPath: ctx.config.solanaPath
        },
        startedAtMs: setupStartedAtMs
      })
    await persistence.captureClusterConfig()
    await persistence.publishSetup({
      schemaVersion: RunEvidenceSchemaVersion,
      stage: RunEvidenceStage.Setup,
      status: RunEvidenceSetupStatus.Succeeded,
      startedAtMs: setupStartedAtMs,
      endedAtMs: decimalTimestamp(Date.now()),
      clusterConfigCreated: true
    })
    log.info(
      `[SwapStressSaturation] run evidence allocated at ${persistence.runDirectory} (runId=${persistence.runId})`
    )
    const runner = createSwapStressPhaseRunner(
        createPhaseRunnerDependencies(ctx, input, persistence)
      ),
      result = await runSaturationRamp({
        persistence,
        config: rampConfig,
        runIteration: iteration => runner.runIteration(iteration.accountCount)
      })
    ctx.outputs.set(Outputs.stressRampResult, result)
    log.info(
      `[SwapStressSaturation] ramp concluded: status=${result.status} ` +
        `saturated=[${result.saturatedEndpoints.join(", ")}] ` +
        `missing=[${result.missingEndpoints.join(", ")}] ` +
        `iterations=${result.iterations.length}`
    )
  }

  // ── Verify runner: both Ethereum directions saturated ────────────────────

  /**
   * Verify runner (the scenario wraps it in a `verifyStep`): the stored ramp
   * result reports `saturated` with NO missing required endpoint — i.e. BOTH
   * Ethereum OPP directions (`OutpostEthereumDepot` + `DepotOutpostEthereum`)
   * saturated.
   */
  export async function runVerifySaturation<C extends SwapScenarioContext>(
    ctx: C,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const result = ctx.outputs.assert(Outputs.stressRampResult)
    Assert.ok(
      result.status === "saturated",
      `expected both Ethereum OPP directions to saturate, received:\n${formatRampResult(result)}`
    )
    Assert.ok(
      result.missingEndpoints.length === 0,
      `saturated ramp still reports missing endpoints:\n${formatRampResult(result)}`
    )
  }

  /**
   * Format a ramp result for assertion messages, tolerating bigint evidence
   * fields (`JSON.stringify` throws on raw bigints).
   *
   * @param result - The ramp result to render.
   * @returns Indented JSON with bigints stringified.
   */
  export function formatRampResult(result: StressRampResult): string {
    return JSON.stringify(result, bigintSafeReplacer, JsonIndent)
  }

  // ── Phase-runner dependency wiring (values resolved from ctx) ────────────

  /**
   * Assemble the `swap-stress` phase-runner dependencies from the
   * live cluster: route codes, live reserve books, the swap user's bound
   * `ReserveManager`, the typed `swapfromwire` submitter, delta-based payout
   * observers, the batch-operator failure probe, and real OPP telemetry.
   *
   * @param ctx - The build context (clients + outputs + config).
   * @param input - The campaign step input (concurrency).
   * @param persistence - The allocated run-evidence sink.
   * @returns The complete phase-runner dependency set.
   */
  export function createPhaseRunnerDependencies<C extends SwapScenarioContext>(
    ctx: C,
    input: RunCampaignInput,
    persistence: RunEvidencePersistence
  ): SwapStressPhaseRunnerDeps {
    const swapUser = ctx.outputs.assert(swapUserOutputKey()),
      reserveManager =
        Artifacts.loadReserveManager<Artifacts.ReserveManagerPrivateReserveContract>(
          ctx,
          swapUser.ethereumWallet
        )
    return {
      route: routeCodes(),
      readReservePairSnapshot: () => readReservePairSnapshot(ctx),
      ethereumReserveManager: reserveManager,
      getEthereumFirstNonce: count => resolveLatestNonce(reserveManager, count),
      submitPhase2Swap: request => submitPhase2Swap(ctx, request),
      recipientPayoutObserver: wirePayoutObserver(ctx.wire),
      returnPayoutObserver: ethereumPayoutObserver(ctx.ethereum),
      batchOperatorFailureProbe: request =>
        Promise.resolve(
          findBatchOperatorFailure(
            ctx.config,
            request.startedAtMs,
            request.endedAtMs
          )
        ),
      concurrency: input.concurrency,
      ...createCampaignTelemetryDependencies(
        ctx.config.clusterPath,
        persistence
      )
    }
  }

  /**
   * Route codes for the bidirectional stress swaps: phase 1 sources native ETH
   * via the ETH/PRIMARY public reserve toward WIRE recipients; phase 2 sources
   * WIRE via `swapfromwire` back toward the paired ETH addresses.
   *
   * @returns The slug route constants as bigints.
   */
  export function routeCodes(): SwapStressRouteCodes {
    return {
      ethereumChainCode: BigInt(Constants.Reserves.Ethereum.ChainCode),
      ethereumTokenCode: BigInt(Constants.Reserves.Ethereum.TokenCode),
      solanaChainCode: BigInt(Constants.Reserves.Solana.ChainCode),
      solanaTokenCode: BigInt(Constants.Reserves.Solana.TokenCode),
      wireChainCode: BigInt(Constants.Reserves.Wire.ChainCode),
      wireTokenCode: BigInt(Constants.Reserves.Wire.TokenCode),
      wireSentinelReserveCode: BigInt(
        Constants.Reserves.Wire.SentinelReserveCode
      ),
      privateReserveCode: BigInt(Constants.Reserves.PrivateReserveCode)
    }
  }

  /**
   * The live quote baseline the phase runner reads before every burst: the
   * ETH/PRIMARY public book (the phase-1 source / phase-2 target side) and the
   * SOLANA-USDCSOL/PRIVATE book (the pair's non-native side).
   *
   * @param ctx - The scenario context (typed reserve reads).
   * @returns Both books in the runner's snapshot shape.
   */
  export async function readReservePairSnapshot(
    ctx: SwapScenarioContext
  ): Promise<SwapStressReservePairSnapshot> {
    const ethereum = await ctx.reserveBook(
        Constants.Reserves.Ethereum.ChainCode,
        Constants.Reserves.Ethereum.TokenCode,
        Constants.Reserves.Wire.SentinelReserveCode
      ),
      solana = await ctx.reserveBook(
        Constants.Reserves.Solana.ChainCode,
        Constants.Reserves.Solana.TokenCode,
        Constants.Reserves.PrivateReserveCode
      )
    return { ethereum, solana }
  }

  /**
   * Submit ONE phase-2 `sysio.uwrit::swapfromwire` write, authorized by the
   * sourcing stress account, targeting the paired ETH address (EVM recipient).
   *
   * @param ctx - The build context (typed wire client).
   * @param burst - The indexed burst request.
   * @returns The transaction id (or a deterministic fallback id).
   */
  export async function submitPhase2Swap<C extends SwapScenarioContext>(
    ctx: C,
    burst: SolanaBurstRequest<Phase2SwapRequest>
  ): Promise<string> {
    const { request } = burst,
      data: SysioContracts.SysioUwritSwapfromwireAction = {
        user: request.sourceAccount,
        wire_amount: Number(request.sourceAmount),
        dst_chain_code: { value: Number(request.targetChainCode) },
        dst_token_code: { value: Number(request.targetTokenCode) },
        dst_reserve_code: { value: Number(request.targetReserveCode) },
        target_amount: Number(request.targetAmount),
        target_tolerance_bps: request.targetToleranceBps,
        recipient_kind: SysioUwritChainkind.CHAIN_KIND_EVM,
        recipient_addr: Buffer.from(request.targetRecipient).toString("hex")
      },
      response = await ctx.wire
        .getSysioContract(SysioContractName.uwrit)
        .actions.swapfromwire.invoke(data, {
          authorization: [
            { actor: request.sourceAccount, permission: "active" }
          ]
        })
    return response.transaction_id ?? `wire-swapfromwire-${burst.index}`
  }

  // ── Payout observers (delta-based balance watchers) ──────────────────────

  /**
   * Phase-1 recipient observer: the deterministic stress WIRE accounts'
   * balances cross `baseline + targetAmount` on the depot.
   *
   * @param wire - The typed WIRE client (balance reads).
   * @returns The delta-based payout observer.
   */
  export function wirePayoutObserver(
    wire: WireClient
  ): SwapStressPayoutObserver {
    return balancePayoutObserver(WirePayoutLabel, target =>
      wire.getWireBalance(target.address)
    )
  }

  /**
   * Phase-2 return observer: the paired ETH addresses' native balances cross
   * `baseline + targetAmount` on the Ethereum outpost chain.
   *
   * @param ethereum - The Ethereum client (native balance reads).
   * @returns The delta-based payout observer.
   */
  export function ethereumPayoutObserver(
    ethereum: EthereumClient
  ): SwapStressPayoutObserver {
    return balancePayoutObserver(EthereumPayoutLabel, target =>
      ethereum.getBalance(target.address)
    )
  }

  type PayoutTarget = SwapStressPayoutObservationRequest["targets"][number]
  type PayoutBalanceReader = (target: PayoutTarget) => Promise<bigint>

  /** One delta-based observer over any bigint balance reader. */
  function balancePayoutObserver(
    chainLabel: string,
    readBalance: PayoutBalanceReader
  ): SwapStressPayoutObserver {
    const baselines = new Map<string, bigint>()
    return {
      preparePayouts: request =>
        prepareBaselines(baselines, request, readBalance),
      waitForPayouts: request =>
        waitForBaselinedPayouts(chainLabel, baselines, request, readBalance)
    }
  }

  async function prepareBaselines(
    baselines: Map<string, bigint>,
    request: SwapStressPayoutObservationRequest,
    readBalance: PayoutBalanceReader
  ): Promise<void> {
    await mapSeries(request.targets, async target => {
      baselines.set(target.address, await readBalance(target))
    })
  }

  async function waitForBaselinedPayouts(
    chainLabel: string,
    baselines: Map<string, bigint>,
    request: SwapStressPayoutObservationRequest,
    readBalance: PayoutBalanceReader
  ): Promise<SwapStressPayoutObservation> {
    let observedCount = 0
    await pollUntil(
      `${request.phase} ${chainLabel} payout observed`,
      async () => {
        observedCount = await countBaselinedTargets(
          baselines,
          request,
          readBalance
        )
        return observedCount >= request.minimumObservedCount
      },
      Constants.Timing.PayoutDeadlineMs,
      Constants.Timing.LongPollIntervalMs
    )
    return { ...request, observedCount }
  }

  async function countBaselinedTargets(
    baselines: Map<string, bigint>,
    request: SwapStressPayoutObservationRequest,
    readBalance: PayoutBalanceReader
  ): Promise<number> {
    const observed = await mapSeries(request.targets, async target => {
      const baseline = baselines.get(target.address)
      Assert.ok(
        baseline != null,
        `missing payout baseline for ${target.address}`
      )
      return (await readBalance(target)) >= baseline + request.targetAmount
    })
    return observed.filter(Boolean).length
  }

  // ── Batch-operator failure probe (cluster-log forensics) ─────────────────

  /**
   * Find the first batch-operator delivery failure logged inside a phase
   * window — the probe the phase runner consults when a payout never appears,
   * so breakage evidence carries the concrete plugin error instead of a bare
   * observation timeout.
   *
   * @param config - The cluster config (locates the batch-op node log dirs).
   * @param startedAtMs - Inclusive phase start.
   * @param endedAtMs - Inclusive phase end.
   * @returns The first matching log message, or null when none matched.
   */
  export function findBatchOperatorFailure(
    config: ClusterConfig,
    startedAtMs: number,
    endedAtMs: number
  // eslint-disable-next-line no-restricted-syntax -- this package sets strictNullChecks: true, so the `| null` union IS compiler-enforced
  ): string | null {
    const failure = batchOperatorLogFiles(config)
      .map(filePath =>
        findBatchOperatorFailureInFile(filePath, startedAtMs, endedAtMs)
      )
      .find(message => message !== null)
    return failure ?? null
  }

  function batchOperatorLogFiles(config: ClusterConfig): readonly string[] {
    return NodeConfig.plan(config)
      .filter(node => node.batchOperatorAccount !== null)
      .flatMap(node =>
        dailyLogFiles(Path.join(node.nodePath, PidSources.LogsSubdir))
      )
      .sort()
  }

  function dailyLogFiles(logsPath: string): readonly string[] {
    if (!Fs.existsSync(logsPath)) return []
    return Fs.readdirSync(logsPath, { withFileTypes: true })
      .filter(
        entry =>
          entry.isFile() &&
          entry.name.startsWith(DailyLogPrefix) &&
          entry.name.endsWith(PidSources.JsonlExt)
      )
      .map(entry => Path.join(logsPath, entry.name))
  }

  function findBatchOperatorFailureInFile(
    filePath: string,
    startedAtMs: number,
    endedAtMs: number
  // eslint-disable-next-line no-restricted-syntax -- this package sets strictNullChecks: true, so the `| null` union IS compiler-enforced
  ): string | null {
    const record = Fs.readFileSync(filePath, "utf-8")
      .split("\n")
      .map(line => parseJsonLogLine(line))
      .find(
        parsed =>
          typeof parsed !== "string" &&
          isInWindow(parsed.ts, startedAtMs, endedAtMs) &&
          BatchOperatorFailurePatterns.some(pattern => pattern.test(parsed.msg))
      )
    return typeof record === "object" ? record.msg : null
  }

  function isInWindow(
    timestamp: string,
    startedAtMs: number,
    endedAtMs: number
  ): boolean {
    const timestampMs = Date.parse(timestamp)
    return (
      Number.isFinite(timestampMs) &&
      timestampMs >= startedAtMs &&
      timestampMs <= endedAtMs
    )
  }

  // ── OPP-envelope telemetry (real baseline-correlated collection) ─────────

  /**
   * Real telemetry dependencies: canonical all-key baseline capture over the
   * cluster's `data/opp-debugging/` artifacts and strict deadline-polled phase
   * metric collection, with every selected artifact committed into the run
   * evidence sink.
   *
   * @param clusterPath - Canonical root of the running cluster.
   * @param persistence - The allocated run-evidence sink.
   * @returns Strict real telemetry dependencies for the phase runner.
   */
  export function createCampaignTelemetryDependencies(
    clusterPath: string,
    persistence: RunEvidencePersistence
  ): SwapStressRealTelemetryDeps {
    return {
      telemetryKind: "real",
      captureEnvelopeBaseline: () =>
        pollRealFlowBaseline({
          now: Date.now,
          wait: sleep,
          capture: () => captureEnvelopeBaseline(oppDebuggingPath(clusterPath))
        }),
      collectEnvelopeMetrics: request => {
        const phaseBaseline = { ...request.baseline, artifactRefs: [] }
        return pollRealFlowMetrics(request, {
          now: Date.now,
          wait: sleep,
          collect: async retryRequest =>
            classifyOppPhaseMetrics(
              await collectOppPhaseMetrics(clusterPath, {
                phase: retryRequest.phase,
                startedAtMs: decimalTimestamp(retryRequest.startedAtMs),
                endedAtMs: decimalTimestamp(retryRequest.endedAtMs),
                epochStart: PhaseEpochStart,
                epochEnd: PhaseEpochEnd,
                endpointsType: retryRequest.endpointsType,
                saturationStrategy: CampaignSaturationStrategy,
                saturatedEnvelopeMinBytes:
                  Constants.Ramp.SaturatedEnvelopeMinBytes,
                baseline: phaseBaseline,
                evidenceSink: persistence
              })
            )
        })
      }
    }
  }

  /** A millisecond timestamp as the evidence schema's decimal string. */
  function decimalTimestamp(timestampMs: number): RunEvidenceDecimal {
    return `${BigInt(Math.trunc(timestampMs))}`
  }

  function bigintSafeReplacer(_key: string, value: unknown): unknown {
    return typeof value === "bigint" ? value.toString() : value
  }
}
