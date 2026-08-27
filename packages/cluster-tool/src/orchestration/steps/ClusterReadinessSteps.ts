import { SysioContracts } from "@wireio/sdk-core"

import { ProtocolTiming } from "../../Constants.js"
import {
  ReadinessAssertionError,
  type ReadinessCapable,
  runReadinessAssertion
} from "../../readiness/ReadinessContext.js"
import { ReadinessConfig } from "../../readiness/ReadinessConfig.js"
import { ReadinessOutputs } from "../../readiness/ReadinessOutputs.js"
import {
  ReadinessMaxTableRows,
  readinessBoundedQuery,
  readinessEndpointLabel,
  readinessEnumMatches,
  readinessSlug
} from "../../readiness/readinessUtils.js"
import type { Report } from "../../report/Report.js"
import { sleep } from "../../utils/asyncUtils.js"
import type { OrchestrationContext } from "../OrchestrationContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../ClusterBuildStep.js"
import type { StepInput } from "../StepRunner.js"

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
  ],
  ReadinessEpochProgressRows = 64,
  ReadinessEpochProgressWindowCycles = 2

interface ClusterReadinessInput extends StepInput {
  readonly kind: "ClusterReadinessSteps.Input"
}

interface HeadAdvancementObservation {
  initial: number
  followUp: number
}

interface EpochProgressSample {
  readonly epochIndex: number
  readonly emittedAt: string
}

/** Scheduler states reported by the read-only epoch assessment. */
export enum EpochSchedulerState {
  onTime = "onTime",
  advancingLate = "advancingLate",
  stalledOrUnproven = "stalledOrUnproven"
}

/** Structured assessment of the WIRE epoch scheduler. */
export interface EpochSchedulerAssessment {
  readonly state: EpochSchedulerState
  readonly overdueMs: number
  readonly maximumExtensionMs: number
  readonly progressWindowMs: number
  readonly progressing: boolean
  readonly latestProgressEpoch?: number
  readonly previousProgressEpoch?: number
  readonly latestProgressAt?: string
  readonly latestProgressAgeMs?: number
}

type ReadinessContext = OrchestrationContext & ReadinessCapable
type ReadinessRunner<C extends ReadinessContext> = (
  context: C,
  input: ClusterReadinessInput,
  signal: AbortSignal
) => Promise<void>

/** Cluster-level read-only Step factories shared by CLI and FlowScenario runs. */
export namespace ClusterReadinessSteps {
  /** Record the explicit RPC inputs used by this run. */
  export function planRequiredEndpoints<C extends ReadinessContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, ClusterReadinessInput> {
    return plan(actor, name, description, options, runRequiredEndpoints)
  }

  /** Verify the WIRE chain identity. */
  export function planWireIdentity<C extends ReadinessContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, ClusterReadinessInput> {
    return plan(actor, name, description, options, runWireIdentity)
  }

  /** Verify WIRE head advancement. */
  export function planWireHeadAdvancement<C extends ReadinessContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, ClusterReadinessInput> {
    return plan(actor, name, description, options, runWireHeadAdvancement)
  }

  /** Verify WIRE head freshness. */
  export function planWireHeadFreshness<C extends ReadinessContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, ClusterReadinessInput> {
    return plan(actor, name, description, options, runWireHeadFreshness)
  }

  /** Verify Ethereum chain identity. */
  export function planEthereumIdentity<C extends ReadinessContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, ClusterReadinessInput> {
    return plan(actor, name, description, options, runEthereumIdentity)
  }

  /** Verify Ethereum head advancement. */
  export function planEthereumHeadAdvancement<C extends ReadinessContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, ClusterReadinessInput> {
    return plan(actor, name, description, options, runEthereumHeadAdvancement)
  }

  /** Verify Solana health and genesis identity. */
  export function planSolanaIdentity<C extends ReadinessContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, ClusterReadinessInput> {
    return plan(actor, name, description, options, runSolanaIdentity)
  }

  /** Verify Solana slot advancement. */
  export function planSolanaSlotAdvancement<C extends ReadinessContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, ClusterReadinessInput> {
    return plan(actor, name, description, options, runSolanaSlotAdvancement)
  }

  /** Probe an explicitly supplied Hyperion endpoint. */
  export function planHyperionHealth<C extends ReadinessContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, ClusterReadinessInput> {
    return plan(actor, name, description, options, runHyperionHealth)
  }

  /** Verify required WIRE system-contract ABI surfaces. */
  export function planWireContracts<C extends ReadinessContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, ClusterReadinessInput> {
    return plan(actor, name, description, options, runWireContracts)
  }

  /** Verify active epoch scheduling. */
  export function planEpochScheduler<C extends ReadinessContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, ClusterReadinessInput> {
    return plan(actor, name, description, options, runEpochScheduler)
  }

  /** Verify the active Ethereum and Solana chain registry. */
  export function planChainRegistry<C extends ReadinessContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, ClusterReadinessInput> {
    return plan(actor, name, description, options, runChainRegistry)
  }
}

function plan<C extends ReadinessContext>(
  actor: Report.Actor,
  name: string,
  description: string,
  options: ClusterBuildStepOptions,
  runner: ReadinessRunner<C>
): ClusterBuildStep<C, ClusterReadinessInput> {
  return ClusterBuildStep.create(
    actor,
    name,
    description,
    options,
    { kind: "ClusterReadinessSteps.Input" },
    runner
  )
}

/** Record the three explicit endpoint inputs. */
export async function runRequiredEndpoints<C extends ReadinessContext>(
  context: C,
  _input: ClusterReadinessInput,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  await runReadinessAssertion(context, async () => ({
    detail: "WIRE, Ethereum, and Solana endpoints were supplied explicitly",
    evidence: {
      wire: readinessEndpointLabel(context.readiness.config.endpoints.wireRpc),
      ethereum: readinessEndpointLabel(
        context.readiness.config.endpoints.ethereumRpc
      ),
      solana: readinessEndpointLabel(
        context.readiness.config.endpoints.solanaRpc
      )
    }
  }))
}

/** Verify the exact WIRE chain id when the caller supplied one. */
export async function runWireIdentity<C extends ReadinessContext>(
  context: C,
  _input: ClusterReadinessInput,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  await runReadinessAssertion(context, async () => {
    const info = await context.readiness.wireApi.v1.chain.get_info(),
      observed = info.chain_id.toString().toLowerCase(),
      expected = context.readiness.config.expectedWireChainId
    if (expected != null && observed !== expected) {
      throw new ReadinessAssertionError(
        `WIRE RPC returned ${observed}, expected ${expected}`,
        { observed, expected }
      )
    }
    context.outputs.set(ReadinessOutputs.observedWireChainId, observed)
    return {
      detail: `WIRE RPC returned chain ${observed}`,
      evidence: {
        observed,
        expected: expected ?? "observed-only-flow",
        headBlock: info.head_block_num,
        irreversibleBlock: info.last_irreversible_block_num
      }
    }
  })
}

/** Observe WIRE head-block advancement. */
export async function runWireHeadAdvancement<C extends ReadinessContext>(
  context: C,
  _input: ClusterReadinessInput,
  signal: AbortSignal
): Promise<void> {
  await runReadinessAssertion(context, async () => {
    const { initial, followUp } = await observeAdvancement(
      "WIRE",
      async () =>
        Number(
          (await context.readiness.wireApi.v1.chain.get_info()).head_block_num
        ),
      context.readiness.config.observationMs,
      signal
    )
    return {
      detail: `WIRE advanced from ${initial} to ${followUp}`,
      evidence: { initial, followUp }
    }
  })
}

/** Verify that the WIRE head timestamp is current. */
export async function runWireHeadFreshness<C extends ReadinessContext>(
  context: C,
  _input: ClusterReadinessInput,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  await runReadinessAssertion(context, async () => {
    const value = (
        await context.readiness.wireApi.v1.chain.get_info()
      ).head_block_time.toString(),
      timestamp = parseWireTimestamp(value),
      ageMs = Date.now() - timestamp
    if (
      !Number.isFinite(timestamp) ||
      Math.abs(ageMs) > ReadinessConfig.FreshWireHeadLimitMs
    ) {
      throw new ReadinessAssertionError(
        `WIRE head time is outside the ${ReadinessConfig.FreshWireHeadLimitMs / 1_000}s freshness window`,
        { headBlockTime: value, ageMs }
      )
    }
    return {
      detail: `WIRE head is ${Math.max(0, Math.round(ageMs / 1_000))}s old`,
      evidence: { headBlockTime: value, ageMs }
    }
  })
}

/** Verify Ethereum identity and retain it for registry comparison. */
export async function runEthereumIdentity<C extends ReadinessContext>(
  context: C,
  _input: ClusterReadinessInput,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  await runReadinessAssertion(context, async () => {
    const raw = await context.readiness.jsonRpc<string>(
        context.readiness.config.endpoints.ethereumRpc,
        "eth_chainId",
        []
      ),
      observed = Number.parseInt(raw, 16),
      expected = context.readiness.config.expectedEthereumChainId
    if (!Number.isSafeInteger(observed) || observed <= 0) {
      throw new ReadinessAssertionError(
        `Ethereum RPC returned invalid chain id ${raw}`,
        { raw }
      )
    }
    if (expected != null && observed !== expected) {
      throw new ReadinessAssertionError(
        `Ethereum RPC returned chain ${observed}, expected ${expected}`,
        { observed, expected, raw }
      )
    }
    context.outputs.set(ReadinessOutputs.observedEthereumChainId, observed)
    return {
      detail: `Ethereum RPC returned chain ${observed}`,
      evidence: { observed, expected: expected ?? "WIRE-registry" }
    }
  })
}

/** Observe Ethereum block advancement. */
export async function runEthereumHeadAdvancement<C extends ReadinessContext>(
  context: C,
  _input: ClusterReadinessInput,
  signal: AbortSignal
): Promise<void> {
  await runReadinessAssertion(context, async () => {
    const { initial, followUp } = await observeAdvancement(
      "Ethereum",
      async () =>
        Number.parseInt(
          await context.readiness.jsonRpc<string>(
            context.readiness.config.endpoints.ethereumRpc,
            "eth_blockNumber",
            []
          ),
          16
        ),
      context.readiness.config.observationMs,
      signal
    )
    return {
      detail: `Ethereum advanced from ${initial} to ${followUp}`,
      evidence: { initial, followUp }
    }
  })
}

/** Verify Solana health and genesis identity. */
export async function runSolanaIdentity<C extends ReadinessContext>(
  context: C,
  _input: ClusterReadinessInput,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  await runReadinessAssertion(context, async () => {
    const endpoint = context.readiness.config.endpoints.solanaRpc,
      health = await context.readiness.jsonRpc<string>(
        endpoint,
        "getHealth",
        []
      ),
      observed = await context.readiness.jsonRpc<string>(
        endpoint,
        "getGenesisHash",
        []
      ),
      expected = context.readiness.config.expectedSolanaGenesisHash
    if (health !== "ok") throw new Error(`Solana getHealth returned ${health}`)
    if (expected != null && observed !== expected) {
      throw new ReadinessAssertionError(
        `Solana RPC returned genesis ${observed}, expected ${expected}`,
        { observed, expected }
      )
    }
    context.outputs.set(ReadinessOutputs.observedSolanaGenesisHash, observed)
    return {
      detail: `Solana RPC is healthy with genesis ${observed}`,
      evidence: { observed, expected: expected ?? "observed-only" }
    }
  })
}

/** Observe Solana slot advancement. */
export async function runSolanaSlotAdvancement<C extends ReadinessContext>(
  context: C,
  _input: ClusterReadinessInput,
  signal: AbortSignal
): Promise<void> {
  await runReadinessAssertion(context, async () => {
    const { initial, followUp } = await observeAdvancement(
      "Solana",
      () =>
        context.readiness.jsonRpc<number>(
          context.readiness.config.endpoints.solanaRpc,
          "getSlot",
          []
        ),
      context.readiness.config.observationMs,
      signal
    )
    return {
      detail: `Solana advanced from slot ${initial} to ${followUp}`,
      evidence: { initial, followUp }
    }
  })
}

/** Probe an explicitly configured Hyperion health endpoint. */
export async function runHyperionHealth<C extends ReadinessContext>(
  context: C,
  _input: ClusterReadinessInput,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  await runReadinessAssertion(context, async () => {
    const endpoint = context.readiness.config.endpoints.hyperionUrl
    if (endpoint == null) throw new Error("Hyperion endpoint is not configured")
    await context.readiness.fetchJson<Record<string, unknown>>(
      `${endpoint}/v2/health`
    )
    return {
      detail: "Hyperion health endpoint returned JSON",
      evidence: { endpoint: readinessEndpointLabel(endpoint) }
    }
  })
}

/** Compare live WIRE ABIs to the generated sdk-core contract definitions. */
export async function runWireContracts<C extends ReadinessContext>(
  context: C,
  _input: ClusterReadinessInput,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  await runReadinessAssertion(context, async () => {
    const failures = (
      await Promise.all(
        RequiredSwapContracts.map(async contract => {
          const definition = SysioContractDefinitions[contract],
            result = await context.readiness.wireApi.v1.chain.get_abi(
              definition.account
            )
          if (result.abi == null) return [`${contract}: ABI missing`]
          const actions = new Set(
              (result.abi.actions ?? []).map(action => String(action.name))
            ),
            tables = new Set(
              (result.abi.tables ?? []).map(table => String(table.name))
            )
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
    if (failures.length > 0) {
      throw new ReadinessAssertionError(failures.join("; "), { failures })
    }
    return {
      detail:
        "All required swap system-contract action and table surfaces are deployed",
      evidence: { contracts: RequiredSwapContracts }
    }
  })
}

/** Verify epoch configuration, timeliness, and recent progression evidence. */
export async function runEpochScheduler<C extends ReadinessContext>(
  context: C,
  _input: ClusterReadinessInput,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  await runReadinessAssertion(context, async () => {
    const progressPromise = context.readiness.wireSystem.msgch.tables.envlog
        .query({ limit: ReadinessEpochProgressRows, reverse: true })
        .then(result => ({ rows: result.rows, error: "" }))
        .catch((error: unknown) => ({
          rows: [],
          error: error instanceof Error ? error.message : String(error)
        })),
      [configResult, stateResult, progressResult] = await Promise.all([
        readinessBoundedQuery(
          context.readiness.wireSystem.epoch.tables.epochcfg.query({
            limit: ReadinessMaxTableRows
          }),
          "sysio.epoch::epochcfg"
        ),
        readinessBoundedQuery(
          context.readiness.wireSystem.epoch.tables.epochstate.query({
            limit: ReadinessMaxTableRows
          }),
          "sysio.epoch::epochstate"
        ),
        progressPromise
      ]),
      config = configResult.rows[0],
      state = stateResult.rows[0]
    if (config == null || state == null) {
      throw new Error("sysio.epoch configuration or state is missing")
    }
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
      evidence = {
        classification: assessment.state,
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
    if (state.is_paused) {
      throw new ReadinessAssertionError("sysio.epoch is paused", evidence)
    }
    if (
      !Number.isInteger(currentEpoch) ||
      currentEpoch < 0 ||
      !Number.isFinite(epochDurationSec) ||
      epochDurationSec <= 0 ||
      !Number.isFinite(assessment.overdueMs)
    ) {
      throw new ReadinessAssertionError(
        "sysio.epoch has invalid scheduler configuration",
        evidence
      )
    }
    if (assessment.state === EpochSchedulerState.stalledOrUnproven) {
      throw new ReadinessAssertionError(
        `Epoch ${currentEpoch} is ${Math.round(assessment.overdueMs / 1_000)}s behind its next boundary; recent progression was not proven`,
        evidence
      )
    }
    return {
      detail:
        assessment.state === EpochSchedulerState.advancingLate
          ? `Epoch ${currentEpoch} is actively catching up from a ${Math.round(assessment.overdueMs / 1_000)}s schedule backlog`
          : `Epoch ${currentEpoch} is on time with a ${epochDurationSec}s duration`,
      evidence
    }
  })
}

/** Verify active EVM/SVM rows and compare the EVM row to the live RPC. */
export async function runChainRegistry<C extends ReadinessContext>(
  context: C,
  _input: ClusterReadinessInput,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  await runReadinessAssertion(context, async () => {
    const { rows } = await readinessBoundedQuery(
        context.readiness.wireSystem.chains.tables.chains.query({
          limit: ReadinessMaxTableRows
        }),
        "sysio.chains::chains"
      ),
      active = rows.filter(row => row.active),
      ethereum = active.find(row =>
        readinessEnumMatches(
          row.kind,
          SysioChainsChainkind.CHAIN_KIND_EVM,
          "CHAIN_KIND_EVM"
        )
      ),
      solana = active.find(row =>
        readinessEnumMatches(
          row.kind,
          SysioChainsChainkind.CHAIN_KIND_SVM,
          "CHAIN_KIND_SVM"
        )
      ),
      observedEthereumChainId = context.outputs.get(
        ReadinessOutputs.observedEthereumChainId
      ),
      errors = [
        ethereum == null ? "active EVM chain row missing" : null,
        solana == null ? "active SVM chain row missing" : null,
        ethereum != null &&
        observedEthereumChainId != null &&
        Number(ethereum.external_chain_id) !== observedEthereumChainId
          ? `EVM external_chain_id ${ethereum.external_chain_id} does not match RPC ${observedEthereumChainId}`
          : null
      ].filter((error): error is string => error != null)
    if (errors.length > 0) {
      throw new ReadinessAssertionError(errors.join("; "), { errors })
    }
    return {
      detail: "sysio.chains has active Ethereum and Solana rows",
      evidence: {
        ethereum: ethereum == null ? "missing" : readinessSlug(ethereum.code),
        ethereumExternalChainId: ethereum?.external_chain_id,
        solana: solana == null ? "missing" : readinessSlug(solana.code)
      }
    }
  })
}

/** Classify scheduler timeliness separately from recent epoch progression. */
export function assessEpochScheduler(
  currentEpoch: number,
  nextEpochStart: string,
  epochDurationSec: number,
  progressSamples: readonly EpochProgressSample[],
  nowMs: number = Date.now()
): EpochSchedulerAssessment {
  const validConfiguration =
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
        emittedAtMs: parseWireTimestamp(sample.emittedAt)
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
      validConfiguration &&
      latestProgressEpoch != null &&
      previousProgressEpoch != null &&
      latestProgressEpoch >= currentEpoch - 1 &&
      latestProgressEpoch <= currentEpoch &&
      previousProgressEpoch === latestProgressEpoch - 1 &&
      latestProgressAgeMs <= progressWindowMs,
    state =
      validConfiguration &&
      Number.isFinite(overdueMs) &&
      overdueMs <= maximumExtensionMs
        ? EpochSchedulerState.onTime
        : progressing
          ? EpochSchedulerState.advancingLate
          : EpochSchedulerState.stalledOrUnproven
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

/** Measure how far a WIRE epoch has run past its scheduled boundary. */
export function epochOverdueMs(
  nextEpochStart: string,
  nowMs: number = Date.now()
): number {
  const timestamp = parseWireTimestamp(nextEpochStart)
  return Number.isFinite(timestamp) ? Math.max(0, nowMs - timestamp) : NaN
}

/** Observe a monotonically increasing chain value within a bounded window. */
export async function observeAdvancement(
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

function parseWireTimestamp(timestamp: string): number {
  return Date.parse(timestamp.endsWith("Z") ? timestamp : `${timestamp}Z`)
}
