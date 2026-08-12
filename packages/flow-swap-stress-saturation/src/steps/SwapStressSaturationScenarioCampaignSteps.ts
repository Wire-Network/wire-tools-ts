import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"

import { SysioContracts } from "@wireio/sdk-core"
import { oppDebuggingPath, parseJsonLogLine, PidSources } from "@wireio/debugging-shared"
import { captureEnvelopeBaseline } from "../envelope-integrity/index.js"
import {
  NodeConfig,
  outputKey,
  SwapScenarioContext,
  mapSeries,
  pollUntil,
  sleep,
  swapUserOutputKey,
  type EthereumClient,
  type WireClient
} from "@wireio/cluster-tool"
import type { ClusterConfig } from "@wireio/cluster-tool-shared"
import {
  classifyOppPhaseMetrics,
  pollRealFlowBaseline,
  pollRealFlowMetrics,
  type Phase2SwapRequest,
  type SolanaBurstRequest,
  type SwapStressPayoutObservation,
  type SwapStressPayoutObservationRequest,
  type SwapStressPayoutObserver,
  type SwapStressRealTelemetryDeps,
  type SwapStressReservePairSnapshot,
  type SwapStressRouteCodes
} from "../swap-stress/index.js"
import {
  ReportArtifactSink,
  collectOppPhaseMetrics,
  type OppEnvelopeSaturationStrategy,
  type OppPhaseEvidenceSink,
  type RunEvidenceDecimal
} from "../stress-engine/index.js"
import { SwapStressSaturationScenarioArtifacts as Artifacts } from "../SwapStressSaturationScenarioArtifacts.js"
import { SwapStressSaturationScenarioConstants as Constants } from "../SwapStressSaturationScenarioConstants.js"

const { SysioContractName, SysioUwritChainkind } = SysioContracts

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

  // ── Campaign-scoped services (built once, shared by every rung Step) ─────

  /**
   * Live services every rung Step shares.
   *
   * These are NOT steps: nothing here writes to a chain — it resolves clients,
   * contracts, and observers. The bundle MUST be a singleton for the whole
   * campaign because the payout observers own the mutable
   * `Map<address, balance>` that `preparePayouts` snapshots and
   * `waitForPayouts` compares against; rebuilding them per Step would empty
   * that map and every payout wait would fail its baseline assertion.
   */
  export interface CampaignServices extends SwapStressRealTelemetryDeps {
    /** Slug route constants for both stress directions. */
    readonly route: SwapStressRouteCodes
    /** The swap user's bound `ReserveManager` (phase-1 submissions + nonces). */
    readonly ethereumReserveManager: Artifacts.ReserveManagerPrivateReserveContract
    /** WIRE-side delta observer credited by phase 1. */
    readonly recipientPayoutObserver: SwapStressPayoutObserver
    /** Ethereum-side delta observer credited by phase 2. */
    readonly returnPayoutObserver: SwapStressPayoutObserver
  }

  /** Cached campaign services — one bundle per run. */
  const campaignServicesKey = outputKey<CampaignServices>(
    "stressSaturation.campaignServices",
    "campaign-scoped clients, contracts, observers, and telemetry"
  )

  /**
   * The campaign's shared services, built on first use and cached on
   * `ctx.outputs` so every rung Step sees the same observer instances.
   *
   * @param ctx - The build context (clients + outputs + config).
   * @returns The shared campaign services.
   */
  export async function campaignServices<C extends SwapScenarioContext>(
    ctx: C
  ): Promise<CampaignServices> {
    const cached = ctx.outputs.get(campaignServicesKey)
    if (cached !== null) return cached
    const swapUser = ctx.outputs.assert(swapUserOutputKey()),
      services: CampaignServices = {
        route: routeCodes(),
        ethereumReserveManager:
          Artifacts.loadReserveManager<Artifacts.ReserveManagerPrivateReserveContract>(
            ctx,
            swapUser.ethereumWallet
          ),
        recipientPayoutObserver: wirePayoutObserver(ctx.wire),
        returnPayoutObserver: ethereumPayoutObserver(ctx.ethereum),
        ...createCampaignTelemetryDependencies(
          ctx.config.clusterPath,
          ReportArtifactSink.create(ctx.config.report.path)
        )
      }
    ctx.outputs.set(campaignServicesKey, services)
    return Promise.resolve(services)
  }

  // ── OPP-envelope telemetry (real baseline-correlated collection) ─────────

  /**
   * Real telemetry dependencies: canonical all-key baseline capture over the
   * cluster's `data/opp-debugging/` artifacts and strict deadline-polled phase
   * metric collection, with every selected artifact committed into the run
   * evidence sink.
   *
   * @param clusterPath - Canonical root of the running cluster.
   * @param evidenceSink - Artifact sink, or null to measure without capturing.
   * @returns Strict real telemetry dependencies for the phase runner.
   */
  export function createCampaignTelemetryDependencies(
    clusterPath: string,
    evidenceSink: OppPhaseEvidenceSink | null
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
                evidenceSink
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

}
