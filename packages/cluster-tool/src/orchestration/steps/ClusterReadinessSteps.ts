import { SysioContracts } from "@wireio/sdk-core"
import {
  ClusterEpochSchedulerState,
  ClusterReadinessArea,
  ClusterReadinessCheckId,
  ClusterReadinessEndpointKind,
  ClusterReadinessReasonCode
} from "@wireio/cluster-tool-shared"

import { ProtocolTiming } from "../../Constants.js"
import { ReadinessConfig } from "../../readiness/ReadinessConfig.js"
import {
  ReadinessAssertionError,
  ReadinessContext
} from "../../readiness/ReadinessContext.js"
import { ReadinessOutputs } from "../../readiness/ReadinessOutputs.js"
import {
  ReadinessMaxTableRows,
  readinessBoundedQuery,
  readinessEnumMatches,
  readinessErrorMessage,
  readinessSlug
} from "../../readiness/readinessUtils.js"
import { sleep } from "../../utils/asyncUtils.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../ClusterBuildStep.js"
import type { Report } from "../../report/Report.js"
import {
  runReadinessAssertion,
  type ReadinessCheckStepInput
} from "./ReadinessStepTools.js"

const { SysioChainsChainkind, SysioContractDefinitions, SysioContractName } =
  SysioContracts

const RequiredSwapContracts = [
  SysioContractName.chains,
  SysioContractName.tokens,
  SysioContractName.epoch,
  SysioContractName.msgch,
  SysioContractName.opreg,
  SysioContractName.reserv,
  SysioContractName.uwrit
]

const ReadinessEpochProgressRows = 64,
  ReadinessEpochProgressWindowCycles = 2

interface EpochProgressSample {
  readonly epochIndex: number
  readonly emittedAt: string
}

interface EpochSchedulerAssessment {
  readonly state: ClusterEpochSchedulerState
  readonly overdueMs: number
  readonly maximumExtensionMs: number
  readonly progressWindowMs: number
  readonly progressing: boolean
  readonly latestProgressEpoch?: number
  readonly previousProgressEpoch?: number
  readonly latestProgressAt?: string
  readonly latestProgressAgeMs?: number
}

interface ClusterReadinessInput extends ReadinessCheckStepInput {
  readonly kind: "ClusterReadinessSteps.Input"
}

interface HeadAdvancementObservation {
  initial: number
  followUp: number
}

/** Cluster-level read-only Step factories shared by every feature suite. */
export namespace ClusterReadinessSteps {
  /** Validate endpoint-catalog discovery. */
  export function planEndpointCatalog(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ) {
    return plan(
      actor,
      name,
      description,
      options,
      ClusterReadinessCheckId["discovery.endpoint-catalog"],
      ClusterReadinessArea.discovery,
      false,
      ClusterReadinessReasonCode["configuration-incomplete"],
      runEndpointCatalog
    )
  }

  /** Validate that Wire, Ethereum, and Solana endpoints were selected. */
  export function planRequiredEndpoints(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ) {
    return plan(
      actor,
      name,
      description,
      options,
      ClusterReadinessCheckId["discovery.required-endpoints"],
      ClusterReadinessArea.discovery,
      true,
      ClusterReadinessReasonCode["configuration-incomplete"],
      runRequiredEndpoints
    )
  }

  /** Verify the exact Wire chain identity. */
  export function planWireIdentity(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ) {
    return plan(
      actor,
      name,
      description,
      options,
      ClusterReadinessCheckId["wire.identity"],
      ClusterReadinessArea.cluster,
      true,
      ClusterReadinessReasonCode["network-unavailable"],
      runWireIdentity
    )
  }

  /** Verify Wire head advancement. */
  export function planWireHeadAdvancement(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ) {
    return plan(
      actor,
      name,
      description,
      options,
      ClusterReadinessCheckId["wire.head-advancement"],
      ClusterReadinessArea.cluster,
      true,
      ClusterReadinessReasonCode["network-unavailable"],
      runWireHeadAdvancement
    )
  }

  /** Verify Wire head freshness. */
  export function planWireHeadFreshness(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ) {
    return plan(
      actor,
      name,
      description,
      options,
      ClusterReadinessCheckId["wire.head-freshness"],
      ClusterReadinessArea.cluster,
      true,
      ClusterReadinessReasonCode["network-unavailable"],
      runWireHeadFreshness
    )
  }

  /** Verify Ethereum chain identity. */
  export function planEthereumIdentity(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ) {
    return plan(
      actor,
      name,
      description,
      options,
      ClusterReadinessCheckId["ethereum.identity"],
      ClusterReadinessArea.cluster,
      true,
      ClusterReadinessReasonCode["network-unavailable"],
      runEthereumIdentity
    )
  }

  /** Verify Ethereum head advancement. */
  export function planEthereumHeadAdvancement(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ) {
    return plan(
      actor,
      name,
      description,
      options,
      ClusterReadinessCheckId["ethereum.head-advancement"],
      ClusterReadinessArea.cluster,
      true,
      ClusterReadinessReasonCode["network-unavailable"],
      runEthereumHeadAdvancement
    )
  }

  /** Verify Solana health and genesis identity. */
  export function planSolanaIdentity(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ) {
    return plan(
      actor,
      name,
      description,
      options,
      ClusterReadinessCheckId["solana.identity"],
      ClusterReadinessArea.cluster,
      true,
      ClusterReadinessReasonCode["network-unavailable"],
      runSolanaIdentity
    )
  }

  /** Verify Solana slot advancement. */
  export function planSolanaSlotAdvancement(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ) {
    return plan(
      actor,
      name,
      description,
      options,
      ClusterReadinessCheckId["solana.slot-advancement"],
      ClusterReadinessArea.cluster,
      true,
      ClusterReadinessReasonCode["network-unavailable"],
      runSolanaSlotAdvancement
    )
  }

  /** Probe optional Hyperion health. */
  export function planHyperionHealth(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ) {
    return plan(
      actor,
      name,
      description,
      options,
      ClusterReadinessCheckId["hyperion.health"],
      ClusterReadinessArea.cluster,
      false,
      ClusterReadinessReasonCode["configuration-incomplete"],
      runHyperionHealth
    )
  }

  /** Verify required Wire system-contract ABI surfaces. */
  export function planWireContracts(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ) {
    return plan(
      actor,
      name,
      description,
      options,
      ClusterReadinessCheckId["wire.contracts"],
      ClusterReadinessArea.swap,
      true,
      ClusterReadinessReasonCode["deployment-incomplete"],
      runWireContracts
    )
  }

  /** Verify active epoch scheduling. */
  export function planEpochScheduler(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ) {
    return plan(
      actor,
      name,
      description,
      options,
      ClusterReadinessCheckId["wire.epoch-scheduler"],
      ClusterReadinessArea.swap,
      true,
      ClusterReadinessReasonCode["protocol-unavailable"],
      runEpochScheduler
    )
  }

  /** Verify the active external-chain registry. */
  export function planChainRegistry(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ) {
    return plan(
      actor,
      name,
      description,
      options,
      ClusterReadinessCheckId["wire.chain-registry"],
      ClusterReadinessArea.swap,
      true,
      ClusterReadinessReasonCode["configuration-incomplete"],
      runChainRegistry
    )
  }

  /** Emit the explicit nonfunctional staking gate. */
  export function planStakeLifecycle(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ) {
    return plan(
      actor,
      name,
      description,
      options,
      ClusterReadinessCheckId["stake.lifecycle"],
      ClusterReadinessArea.stake,
      true,
      ClusterReadinessReasonCode["protocol-unavailable"],
      runStakeLifecycle
    )
  }
}

function plan(
  actor: Report.Actor,
  name: string,
  description: string,
  options: ClusterBuildStepOptions,
  id: ClusterReadinessCheckId,
  area: ClusterReadinessArea,
  blocking: boolean,
  failureReason: ClusterReadinessReasonCode,
  runner: (
    context: ReadinessContext,
    input: ClusterReadinessInput,
    signal: AbortSignal
  ) => Promise<void>
): ClusterBuildStep<ReadinessContext, ClusterReadinessInput> {
  return ClusterBuildStep.create(
    actor,
    name,
    description,
    options,
    {
      kind: "ClusterReadinessSteps.Input",
      id,
      area,
      blocking,
      failureReason
    },
    runner
  )
}

/** Run endpoint-catalog validation. */
export async function runEndpointCatalog(
  context: ReadinessContext,
  input: ClusterReadinessInput,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  await runReadinessAssertion(context, input, async () => {
    if (context.config.catalogErrors.length > 0) {
      throw new ReadinessAssertionError(
        context.config.catalogErrors.join("; "),
        ClusterReadinessReasonCode["configuration-incomplete"],
        { catalogUrl: context.config.catalogUrl }
      )
    }
    return {
      detail: `Catalog returned ${context.config.catalogRecordCount} active record(s) for the Wire network group`,
      evidence: {
        catalogUrl: context.config.catalogUrl,
        recordCount: context.config.catalogRecordCount
      }
    }
  })
}

/** Run required-endpoint validation. */
export async function runRequiredEndpoints(
  context: ReadinessContext,
  input: ClusterReadinessInput,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  await runReadinessAssertion(context, input, async () => {
    const required = [
        ClusterReadinessEndpointKind.wire,
        ClusterReadinessEndpointKind.ethereum,
        ClusterReadinessEndpointKind.solana
      ],
      missing = required.filter(kind => context.endpoint(kind) == null)
    if (missing.length > 0) {
      throw new ReadinessAssertionError(
        `Missing ${missing.join(", ")} endpoint metadata`,
        ClusterReadinessReasonCode["configuration-incomplete"],
        { missing }
      )
    }
    return {
      detail: "Wire, Ethereum, and Solana endpoints are selected",
      evidence: { selected: required }
    }
  })
}

/** Run exact Wire identity verification. */
export async function runWireIdentity(
  context: ReadinessContext,
  input: ClusterReadinessInput,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  await runReadinessAssertion(context, input, async () => {
    context.assertEndpoint(ClusterReadinessEndpointKind.wire)
    const info = await context.wireApi.v1.chain.get_info(),
      observed = info.chain_id.toString(),
      endpoint = context.endpoint(ClusterReadinessEndpointKind.wire),
      { requestedWireChainId } = context.config,
      expected = requestedWireChainId || endpoint?.expectedChainId
    if (expected && observed.toLowerCase() !== expected.toLowerCase()) {
      throw new ReadinessAssertionError(
        `Wire RPC returned ${observed}, expected ${expected}`,
        ClusterReadinessReasonCode["configuration-incomplete"],
        { observed, expected }
      )
    }
    context.outputs.set(ReadinessOutputs.observedWireChainId, observed)
    return {
      detail: `Wire RPC returned chain ${observed}`,
      evidence: {
        observed,
        headBlock: info.head_block_num,
        irreversibleBlock: info.last_irreversible_block_num
      }
    }
  })
}

/** Run Wire head advancement verification. */
export async function runWireHeadAdvancement(
  context: ReadinessContext,
  input: ClusterReadinessInput,
  signal: AbortSignal
): Promise<void> {
  await runReadinessAssertion(context, input, async () => {
    context.assertEndpoint(ClusterReadinessEndpointKind.wire)
    const { initial, followUp } = await observeAdvancement(
      "Wire",
      async () =>
        Number((await context.wireApi.v1.chain.get_info()).head_block_num),
      context.config.observationMs,
      signal
    )
    return {
      detail: `Wire advanced from ${initial} to ${followUp}`,
      evidence: { initial, followUp }
    }
  })
}

/** Run Wire head freshness verification. */
export async function runWireHeadFreshness(
  context: ReadinessContext,
  input: ClusterReadinessInput,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  await runReadinessAssertion(context, input, async () => {
    context.assertEndpoint(ClusterReadinessEndpointKind.wire)
    const value = (
        await context.wireApi.v1.chain.get_info()
      ).head_block_time.toString(),
      timestamp = Date.parse(value.endsWith("Z") ? value : `${value}Z`),
      ageMs = Date.now() - timestamp
    if (
      !Number.isFinite(timestamp) ||
      Math.abs(ageMs) > ReadinessConfig.FreshWireHeadLimitMs
    ) {
      throw new ReadinessAssertionError(
        `Wire head time is outside the ${ReadinessConfig.FreshWireHeadLimitMs / 1_000}s freshness window`,
        ClusterReadinessReasonCode["network-unavailable"],
        { headBlockTime: value, ageMs }
      )
    }
    return {
      detail: `Wire head is ${Math.max(0, Math.round(ageMs / 1_000))}s old`,
      evidence: { headBlockTime: value, ageMs }
    }
  })
}

/** Run Ethereum identity verification. */
export async function runEthereumIdentity(
  context: ReadinessContext,
  input: ClusterReadinessInput,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  await runReadinessAssertion(context, input, async () => {
    const endpoint = context.assertEndpoint(
        ClusterReadinessEndpointKind.ethereum
      ),
      raw = await context.jsonRpc<string>(endpoint.url, "eth_chainId", []),
      observed = Number.parseInt(raw, 16)
    if (
      endpoint.expectedChainId &&
      String(observed) !== endpoint.expectedChainId
    ) {
      throw new ReadinessAssertionError(
        `Ethereum RPC returned chain ${observed}, expected ${endpoint.expectedChainId}`,
        ClusterReadinessReasonCode["configuration-incomplete"],
        { observed, expected: endpoint.expectedChainId, raw }
      )
    }
    return {
      detail: `Ethereum RPC returned chain ${observed}`,
      evidence: { observed, raw }
    }
  })
}

/** Run Ethereum head advancement verification. */
export async function runEthereumHeadAdvancement(
  context: ReadinessContext,
  input: ClusterReadinessInput,
  signal: AbortSignal
): Promise<void> {
  await runReadinessAssertion(context, input, async () => {
    const endpoint = context.assertEndpoint(
        ClusterReadinessEndpointKind.ethereum
      ),
      { initial, followUp } = await observeAdvancement(
        "Ethereum",
        async () =>
          Number.parseInt(
            await context.jsonRpc<string>(endpoint.url, "eth_blockNumber", []),
            16
          ),
        context.config.observationMs,
        signal
      )
    return {
      detail: `Ethereum advanced from ${initial} to ${followUp}`,
      evidence: { initial, followUp }
    }
  })
}

/** Run Solana identity verification. */
export async function runSolanaIdentity(
  context: ReadinessContext,
  input: ClusterReadinessInput,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  await runReadinessAssertion(context, input, async () => {
    const endpoint = context.assertEndpoint(
        ClusterReadinessEndpointKind.solana
      ),
      health = await context.jsonRpc<string>(endpoint.url, "getHealth", []),
      observed = await context.jsonRpc<string>(
        endpoint.url,
        "getGenesisHash",
        []
      )
    if (health !== "ok") throw new Error(`Solana getHealth returned ${health}`)
    if (endpoint.expectedChainId && observed !== endpoint.expectedChainId) {
      throw new ReadinessAssertionError(
        `Solana RPC returned genesis ${observed}, expected ${endpoint.expectedChainId}`,
        ClusterReadinessReasonCode["configuration-incomplete"],
        { observed, expected: endpoint.expectedChainId }
      )
    }
    return {
      detail: `Solana RPC is healthy with genesis ${observed}`,
      evidence: { observed, health }
    }
  })
}

/** Run Solana slot advancement verification. */
export async function runSolanaSlotAdvancement(
  context: ReadinessContext,
  input: ClusterReadinessInput,
  signal: AbortSignal
): Promise<void> {
  await runReadinessAssertion(context, input, async () => {
    const endpoint = context.assertEndpoint(
        ClusterReadinessEndpointKind.solana
      ),
      { initial, followUp } = await observeAdvancement(
        "Solana",
        () => context.jsonRpc<number>(endpoint.url, "getSlot", []),
        context.config.observationMs,
        signal
      )
    return {
      detail: `Solana advanced from slot ${initial} to ${followUp}`,
      evidence: { initial, followUp }
    }
  })
}

/** Run optional Hyperion health verification. */
export async function runHyperionHealth(
  context: ReadinessContext,
  input: ClusterReadinessInput,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  await runReadinessAssertion(context, input, async () => {
    const endpoint = context.endpoint(ClusterReadinessEndpointKind.hyperion)
    if (!endpoint)
      throw new ReadinessAssertionError(
        "Hyperion endpoint is not configured",
        ClusterReadinessReasonCode["configuration-incomplete"]
      )
    await context.fetchJson<Record<string, unknown>>(
      `${endpoint.url.replace(/\/$/, "")}/v2/health`
    )
    return {
      detail: "Hyperion health endpoint returned JSON",
      evidence: { endpoint: endpoint.url }
    }
  })
}

/** Run required Wire ABI-surface verification. */
export async function runWireContracts(
  context: ReadinessContext,
  input: ClusterReadinessInput,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  await runReadinessAssertion(context, input, async () => {
    context.assertEndpoint(ClusterReadinessEndpointKind.wire)
    const failures = (
      await Promise.all(
        RequiredSwapContracts.map(async contract => {
          const result = await context.wireApi.v1.chain.get_abi(
            SysioContractDefinitions[contract].account
          )
          if (!result.abi) return [`${contract}: ABI missing`]
          const actions = new Set(
              (result.abi.actions ?? []).map(action => String(action.name))
            ),
            tables = new Set(
              (result.abi.tables ?? []).map(table => String(table.name))
            ),
            definition = SysioContractDefinitions[contract]
          return [
            ...definition.actions
              .filter(action => !actions.has(action))
              .map(action => `${contract}::${action} action missing`),
            ...definition.tables
              .filter(table => !tables.has(table))
              .map(table => `${contract}::${table} table missing`)
          ]
        })
      )
    ).flat()
    if (failures.length > 0)
      throw new ReadinessAssertionError(
        failures.join("; "),
        ClusterReadinessReasonCode["deployment-incomplete"],
        { failures }
      )
    return {
      detail:
        "All required swap system-contract action and table surfaces are deployed",
      evidence: { contracts: RequiredSwapContracts }
    }
  })
}

/** Run epoch scheduler verification. */
export async function runEpochScheduler(
  context: ReadinessContext,
  input: ClusterReadinessInput,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  await runReadinessAssertion(context, input, async () => {
    const progressResultPromise = context.wireSystem.msgch.tables.envlog
        .query({
          limit: ReadinessEpochProgressRows,
          reverse: true
        })
        .then(result => ({
          rows: result.rows,
          error: undefined as string | undefined
        }))
        .catch((error: unknown) => ({
          rows: [],
          error: readinessErrorMessage(error)
        })),
      [configResult, stateResult, progressResult] = await Promise.all([
        readinessBoundedQuery(
          context.wireSystem.epoch.tables.epochcfg.query({
            limit: ReadinessMaxTableRows
          }),
          "sysio.epoch::epochcfg"
        ),
        readinessBoundedQuery(
          context.wireSystem.epoch.tables.epochstate.query({
            limit: ReadinessMaxTableRows
          }),
          "sysio.epoch::epochstate"
        ),
        progressResultPromise
      ]),
      config = configResult.rows[0],
      state = stateResult.rows[0]
    if (!config || !state)
      throw new Error("sysio.epoch configuration or state is missing")
    const currentEpoch = Number(state.current_epoch_index),
      epochDurationSec = Number(config.epoch_duration_sec),
      nextEpochStart = state.next_epoch_start.toString(),
      assessment = assessEpochScheduler(
        currentEpoch,
        nextEpochStart,
        epochDurationSec,
        progressResult.rows.map(row => ({
          epochIndex: Number(row.epoch_index),
          emittedAt: row.emitted_at.toString()
        }))
      ),
      validEpochConfiguration =
        Number.isInteger(currentEpoch) &&
        currentEpoch >= 0 &&
        Number.isFinite(epochDurationSec) &&
        epochDurationSec > 0,
      evidence = {
        classification:
          state.is_paused || !validEpochConfiguration
            ? ClusterEpochSchedulerState["stalled-or-unproven"]
            : assessment.state,
        currentEpoch,
        epochDurationSec,
        paused: state.is_paused,
        nextEpochStart,
        overdueMs: assessment.overdueMs,
        maximumExtensionMs: assessment.maximumExtensionMs,
        progressing: assessment.progressing,
        progressWindowMs: assessment.progressWindowMs,
        latestProgressEpoch: assessment.latestProgressEpoch,
        previousProgressEpoch: assessment.previousProgressEpoch,
        latestProgressAt: assessment.latestProgressAt,
        latestProgressAgeMs: assessment.latestProgressAgeMs,
        progressSampleCount: progressResult.rows.length,
        progressQueryError: progressResult.error
      }
    if (
      state.is_paused ||
      !validEpochConfiguration ||
      !Number.isFinite(assessment.overdueMs)
    ) {
      throw new ReadinessAssertionError(
        state.is_paused
          ? "sysio.epoch is paused"
          : !Number.isInteger(currentEpoch) || currentEpoch < 0
            ? "sysio.epoch has an invalid current epoch index"
            : !Number.isFinite(epochDurationSec) || epochDurationSec <= 0
              ? "sysio.epoch has an invalid duration"
              : "sysio.epoch has an invalid next-epoch timestamp",
        ClusterReadinessReasonCode["protocol-unavailable"],
        evidence
      )
    }
    if (assessment.state === ClusterEpochSchedulerState["advancing-late"])
      throw new ReadinessAssertionError(
        `Recent scheduler progression reached epoch ${currentEpoch}, but its next boundary is ${Math.round(assessment.overdueMs / 1_000)}s late`,
        ClusterReadinessReasonCode["protocol-degraded"],
        evidence
      )
    if (assessment.state === ClusterEpochSchedulerState["stalled-or-unproven"])
      throw new ReadinessAssertionError(
        `Epoch ${currentEpoch} is ${Math.round(assessment.overdueMs / 1_000)}s behind its next boundary; recent epoch progression was not proven`,
        ClusterReadinessReasonCode["protocol-unavailable"],
        evidence
      )
    return {
      detail: `Epoch ${currentEpoch} is on time with a ${epochDurationSec}s duration`,
      evidence
    }
  })
}

/**
 * Classify scheduler timeliness separately from recent epoch progression.
 *
 * @param currentEpoch Current `sysio.epoch::epochstate` epoch index.
 * @param nextEpochStart Wire `time_point_sec` string for the next boundary.
 * @param epochDurationSec Configured epoch duration in seconds.
 * @param progressSamples Recent `sysio.msgch::envlog` epoch emissions.
 * @param nowMs Observation time in Unix milliseconds.
 * @return Timeliness and historical progression evidence for reporting.
 */
export function assessEpochScheduler(
  currentEpoch: number,
  nextEpochStart: string,
  epochDurationSec: number,
  progressSamples: readonly EpochProgressSample[],
  nowMs: number = Date.now()
): EpochSchedulerAssessment {
  const validEpochConfiguration =
      Number.isInteger(currentEpoch) &&
      currentEpoch >= 0 &&
      Number.isFinite(epochDurationSec) &&
      epochDurationSec > 0,
    overdueMs = epochOverdueMs(nextEpochStart, nowMs),
    maximumExtensionMs = ProtocolTiming.EpochExtensionMaxSec * 1_000,
    progressWindowMs =
      (epochDurationSec + ProtocolTiming.EpochExtensionMaxSec) *
      ReadinessEpochProgressWindowCycles *
      1_000,
    validSamples = progressSamples
      .map(sample => ({
        ...sample,
        emittedAtMs: readinessTimestampMs(sample.emittedAt)
      }))
      .filter(
        sample =>
          Number.isFinite(sample.epochIndex) &&
          Number.isFinite(sample.emittedAtMs)
      ),
    epochs = [...new Set(validSamples.map(sample => sample.epochIndex))].sort(
      (left, right) => right - left
    ),
    latestProgressEpoch = epochs[0],
    previousProgressEpoch = epochs[1],
    latestSample = validSamples
      .filter(sample => sample.epochIndex === latestProgressEpoch)
      .sort((left, right) => right.emittedAtMs - left.emittedAtMs)[0],
    latestProgressAgeMs = latestSample
      ? Math.max(0, nowMs - latestSample.emittedAtMs)
      : undefined,
    progressing =
      validEpochConfiguration &&
      latestProgressEpoch !== undefined &&
      previousProgressEpoch !== undefined &&
      latestProgressEpoch >= currentEpoch - 1 &&
      latestProgressAgeMs <= progressWindowMs,
    state =
      validEpochConfiguration &&
      Number.isFinite(overdueMs) &&
      overdueMs <= maximumExtensionMs
        ? ClusterEpochSchedulerState["on-time"]
        : progressing
          ? ClusterEpochSchedulerState["advancing-late"]
          : ClusterEpochSchedulerState["stalled-or-unproven"]
  return {
    state,
    overdueMs,
    maximumExtensionMs,
    progressWindowMs,
    progressing,
    latestProgressEpoch,
    previousProgressEpoch,
    latestProgressAt: latestSample?.emittedAt,
    latestProgressAgeMs
  }
}

/**
 * Measure how far a Wire epoch has run past its scheduled next boundary.
 * Wire ABI timestamps omit the UTC suffix, so this applies it before parsing.
 *
 * @param nextEpochStart Wire `time_point_sec` string for the next boundary.
 * @param nowMs Observation time in Unix milliseconds.
 * @return Non-negative overdue milliseconds, or `NaN` for an invalid timestamp.
 */
export function epochOverdueMs(
  nextEpochStart: string,
  nowMs: number = Date.now()
): number {
  const timestamp = readinessTimestampMs(nextEpochStart)
  return Number.isFinite(timestamp) ? Math.max(0, nowMs - timestamp) : NaN
}

function readinessTimestampMs(timestamp: string): number {
  return Date.parse(timestamp.endsWith("Z") ? timestamp : `${timestamp}Z`)
}

/** Run external-chain registry verification. */
export async function runChainRegistry(
  context: ReadinessContext,
  input: ClusterReadinessInput,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  await runReadinessAssertion(context, input, async () => {
    const { rows } = await readinessBoundedQuery(
        context.wireSystem.chains.tables.chains.query({
          limit: ReadinessMaxTableRows
        }),
        "sysio.chains::chains"
      ),
      active = rows.filter(row => row.active),
      ethereumRow = active.find(row =>
        readinessEnumMatches(
          row.kind,
          SysioChainsChainkind.CHAIN_KIND_EVM,
          "CHAIN_KIND_EVM"
        )
      ),
      solanaRow = active.find(row =>
        readinessEnumMatches(
          row.kind,
          SysioChainsChainkind.CHAIN_KIND_SVM,
          "CHAIN_KIND_SVM"
        )
      ),
      ethereumEndpoint = context.endpoint(
        ClusterReadinessEndpointKind.ethereum
      ),
      solanaEndpoint = context.endpoint(ClusterReadinessEndpointKind.solana),
      errors: string[] = []
    if (!ethereumRow) errors.push("active EVM chain row missing")
    if (!solanaRow) errors.push("active SVM chain row missing")
    if (
      ethereumRow &&
      ethereumEndpoint?.expectedChainId &&
      String(ethereumRow.external_chain_id) !== ethereumEndpoint.expectedChainId
    )
      errors.push(
        `EVM external_chain_id ${ethereumRow.external_chain_id} != catalog ${ethereumEndpoint.expectedChainId}`
      )
    if (
      ethereumRow &&
      ethereumEndpoint?.chainCode &&
      readinessSlug(ethereumRow.code) !== ethereumEndpoint.chainCode
    )
      errors.push(
        `EVM chain code ${readinessSlug(ethereumRow.code)} != catalog ${ethereumEndpoint.chainCode}`
      )
    if (
      solanaRow &&
      solanaEndpoint?.chainCode &&
      readinessSlug(solanaRow.code) !== solanaEndpoint.chainCode
    )
      errors.push(
        `SVM chain code ${readinessSlug(solanaRow.code)} != catalog ${solanaEndpoint.chainCode}`
      )
    if (errors.length > 0)
      throw new ReadinessAssertionError(
        errors.join("; "),
        ClusterReadinessReasonCode["configuration-incomplete"],
        { errors }
      )
    return {
      detail:
        "sysio.chains has active EVM and SVM rows aligned with endpoint metadata",
      evidence: {
        ethereum: ethereumRow ? readinessSlug(ethereumRow.code) : null,
        solana: solanaRow ? readinessSlug(solanaRow.code) : null
      }
    }
  })
}

/** Run the intentionally unavailable staking lifecycle gate. */
export async function runStakeLifecycle(
  context: ReadinessContext,
  input: ClusterReadinessInput,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  await runReadinessAssertion(context, input, async () => {
    throw new ReadinessAssertionError(
      "WIRE-301 remains unresolved: no canonical LIQ stake/unstake lifecycle is deployed end to end across Wire, Ethereum, and Solana",
      ClusterReadinessReasonCode["protocol-unavailable"]
    )
  })
}

async function observeAdvancement(
  label: string,
  read: () => Promise<number>,
  observationMs: number,
  signal: AbortSignal
): Promise<HeadAdvancementObservation> {
  const initial = await read(),
    deadline = Date.now() + observationMs
  let followUp = initial

  while (followUp <= initial && Date.now() < deadline) {
    await sleep(
      Math.min(
        ReadinessConfig.AdvancementPollIntervalMs,
        Math.max(1, deadline - Date.now())
      )
    )
    signal.throwIfAborted()
    followUp = await read()
  }

  if (
    !Number.isFinite(initial) ||
    !Number.isFinite(followUp) ||
    followUp <= initial
  ) {
    throw new Error(`${label} did not advance during the observation window`)
  }
  return { initial, followUp }
}
