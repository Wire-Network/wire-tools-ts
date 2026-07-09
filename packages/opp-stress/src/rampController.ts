import * as Fs from "node:fs"
import * as Path from "node:path"

import {
  emptyCampaignSaturation,
  mergeCampaignSaturation,
  type CampaignSaturation
} from "./campaignSaturation.js"

/** Default OPP stress ramp constants for local e2e runs. */
export namespace OppStressRampDefaults {
  /** First account count in a stress ramp. */
  export const InitialCount = 8
  /** Account-count multiplier between non-saturating iterations. */
  export const Multiplier = 2
  /** Safety cap that bounds a stress campaign. */
  export const MaxCount = 512
  /** Per-phase timeout metadata persisted into evidence. */
  export const PhaseTimeoutMs = 480_000
}

/** Immutable OPP stress ramp configuration. */
export type OppStressRampConfig = {
  /** First account count to run. */
  readonly initialCount: number
  /** Multiplier applied after each non-saturating iteration. */
  readonly multiplier: number
  /** Maximum account count before reporting incomplete saturation. */
  readonly maxCount: number
  /** Per-phase timeout carried into evidence metadata. */
  readonly phaseTimeoutMs: number
}

/** Input passed to the caller's OPP workload iteration runner. */
export type OppStressRampIterationInput = {
  /** Zero-based iteration index. */
  readonly iterationIndex: number
  /** Account or request count for this iteration. */
  readonly accountCount: number
  /** Per-phase timeout selected by the ramp config. */
  readonly phaseTimeoutMs: number
}

/** Metrics and classification returned by one OPP stress iteration. */
export type OppStressRampIterationOutcome = {
  /** Iteration classification before campaign aggregation. */
  readonly kind: "not_saturated" | "saturated" | "breakage"
  /** Zero-based iteration index. */
  readonly iterationIndex: number
  /** Account or request count used by this iteration. */
  readonly accountCount: number
  /** Workload phase that produced the final metrics. */
  readonly phase: string
  /** Iteration start timestamp in Unix milliseconds. */
  readonly startedAtMs: number | bigint
  /** Iteration end timestamp in Unix milliseconds. */
  readonly endedAtMs: number | bigint
  /** Successful transaction count across the measured phase. */
  readonly txSuccesses: number
  /** Failed transaction count across the measured phase. */
  readonly txFailures: number
  /** Breakage reason when kind is breakage. */
  readonly breakageReason?: string | null
  /** Matching OPP envelope count for the phase window. */
  readonly envelopeCount: number
  /** Matching OPP envelope byte sizes. */
  readonly envelopeByteSizes: readonly number[]
  /** Endpoint direction label persisted for evidence readers. */
  readonly endpoint: string
  /** Inclusive epoch lower bound for the metrics window. */
  readonly epochStart: number
  /** Inclusive epoch upper bound for the metrics window. */
  readonly epochEnd: number
  /** Required endpoints saturated by this iteration. */
  readonly saturatedEndpoints?: readonly string[]
  /** Non-required endpoints observed as diagnostics only. */
  readonly observedNonRequiredEndpoints?: readonly string[]
}

/** Persisted evidence for one OPP stress ramp iteration. */
export type OppStressRampEvidence = OppStressRampIterationOutcome & {
  /** Finalized status for this iteration's evidence file. */
  readonly status: OppStressRampResultStatus | "running" | "not_saturated"
  /** Whether the caller must retain cluster artifacts after this outcome. */
  readonly preserveCluster: boolean
  /** Ramp constants active for this run. */
  readonly config: OppStressRampConfig
  /** Required endpoints saturated across the campaign so far. */
  readonly saturatedEndpoints: readonly string[]
  /** Required endpoints still missing across the campaign so far. */
  readonly missingEndpoints: readonly string[]
  /** Non-required endpoints observed as diagnostic saturation across the campaign. */
  readonly observedNonRequiredEndpoints: readonly string[]
}

/** Final OPP stress campaign status. */
export type OppStressRampResultStatus =
  | "saturated"
  | "partial_saturation"
  | "failed_before_saturation"
  | "saturation_not_reached"

/** Final ramp result returned to an e2e flow. */
export type OppStressRampResult = {
  /** Final run status. */
  readonly status: OppStressRampResultStatus
  /** Whether cluster artifacts must be preserved by teardown. */
  readonly preserveCluster: boolean
  /** Iterations executed before the controller stopped. */
  readonly iterations: readonly OppStressRampEvidence[]
  /** Required endpoints saturated across the campaign. */
  readonly saturatedEndpoints: readonly string[]
  /** Required endpoints still missing at final status. */
  readonly missingEndpoints: readonly string[]
  /** Non-required endpoints observed as diagnostic saturation across the campaign. */
  readonly observedNonRequiredEndpoints: readonly string[]
}

/** Options for the OPP stress saturation ramp controller. */
export type OppStressRampOptions = {
  /** Directory where per-iteration JSON evidence files are written. */
  readonly evidenceDir: string
  /** Required OPP endpoint labels that must saturate for campaign success. */
  readonly requiredEndpoints: readonly string[]
  /** Ramp constants. */
  readonly config?: OppStressRampConfig
  /** Real or synthetic iteration runner. */
  readonly runIteration: (
    input: OppStressRampIterationInput
  ) => Promise<OppStressRampIterationOutcome>
}

type RampState = {
  readonly accountCount: number
  readonly iterationIndex: number
  readonly priorIterations: readonly OppStressRampEvidence[]
  readonly priorSaturation: CampaignSaturation
}

type EvidenceInput = {
  readonly outcome: OppStressRampIterationOutcome
  readonly config: OppStressRampConfig
  readonly campaignSaturation: CampaignSaturation
  readonly finalMaxStatus:
    "partial_saturation" | "saturation_not_reached" | null
}

/**
 * Run OPP stress iterations until required endpoints saturate, breakage, or max count.
 *
 * @param options Evidence directory, required endpoints, ramp config, and iteration runner.
 * @returns Final ramp status plus in-memory evidence records.
 */
export async function runOppStressRamp(
  options: OppStressRampOptions
): Promise<OppStressRampResult> {
  const config = options.config ?? defaultRampConfig()
  assertRampConfig(config)
  await Fs.promises.mkdir(options.evidenceDir, { recursive: true })
  return runRampAtCount(options, config, {
    accountCount: config.initialCount,
    iterationIndex: 0,
    priorIterations: [],
    priorSaturation: emptyCampaignSaturation(options.requiredEndpoints)
  })
}

function defaultRampConfig(): OppStressRampConfig {
  return {
    initialCount: OppStressRampDefaults.InitialCount,
    multiplier: OppStressRampDefaults.Multiplier,
    maxCount: OppStressRampDefaults.MaxCount,
    phaseTimeoutMs: OppStressRampDefaults.PhaseTimeoutMs
  }
}

async function runRampAtCount(
  options: OppStressRampOptions,
  config: OppStressRampConfig,
  state: RampState
): Promise<OppStressRampResult> {
  const outcome = await options.runIteration({
      iterationIndex: state.iterationIndex,
      accountCount: state.accountCount,
      phaseTimeoutMs: config.phaseTimeoutMs
    }),
    campaignSaturation = mergeCampaignSaturation(
      options.requiredEndpoints,
      state.priorSaturation,
      outcome
    ),
    finalMaxStatus =
      outcome.kind === "not_saturated" && state.accountCount >= config.maxCount
        ? maxStatus(campaignSaturation)
        : null,
    evidence = evidenceFromOutcome({
      outcome,
      config,
      campaignSaturation,
      finalMaxStatus
    })
  await writeIterationEvidence(options.evidenceDir, evidence)
  const iterations = [...state.priorIterations, evidence]
  if (outcome.kind === "breakage") {
    return {
      status: "failed_before_saturation",
      preserveCluster: true,
      iterations,
      ...campaignSaturation
    }
  }
  if (campaignSaturation.missingEndpoints.length === 0) {
    return {
      status: "saturated",
      preserveCluster: false,
      iterations,
      ...campaignSaturation
    }
  }
  switch (outcome.kind) {
    case "saturated":
      return state.accountCount >= config.maxCount
        ? {
            status: maxStatus(campaignSaturation),
            preserveCluster: true,
            iterations,
            ...campaignSaturation
          }
        : runRampAtCount(options, config, {
            accountCount: Math.min(
              state.accountCount * config.multiplier,
              config.maxCount
            ),
            iterationIndex: state.iterationIndex + 1,
            priorIterations: iterations,
            priorSaturation: campaignSaturation
          })
    case "not_saturated":
      return state.accountCount >= config.maxCount
        ? {
            status: maxStatus(campaignSaturation),
            preserveCluster: true,
            iterations,
            ...campaignSaturation
          }
        : runRampAtCount(options, config, {
            accountCount: Math.min(
              state.accountCount * config.multiplier,
              config.maxCount
            ),
            iterationIndex: state.iterationIndex + 1,
            priorIterations: iterations,
            priorSaturation: campaignSaturation
          })
    default:
      return assertNever(outcome.kind)
  }
}

function evidenceFromOutcome(input: EvidenceInput): OppStressRampEvidence {
  switch (input.outcome.kind) {
    case "saturated":
      return {
        ...input.outcome,
        ...input.campaignSaturation,
        status:
          input.campaignSaturation.missingEndpoints.length === 0
            ? "saturated"
            : (input.finalMaxStatus ?? "not_saturated"),
        preserveCluster: input.finalMaxStatus !== null,
        config: input.config
      }
    case "breakage":
      return {
        ...input.outcome,
        ...input.campaignSaturation,
        status: "failed_before_saturation",
        preserveCluster: true,
        config: input.config
      }
    case "not_saturated":
      return {
        ...input.outcome,
        ...input.campaignSaturation,
        status:
          input.campaignSaturation.missingEndpoints.length === 0
            ? "saturated"
            : (input.finalMaxStatus ?? "not_saturated"),
        preserveCluster: input.finalMaxStatus !== null,
        config: input.config
      }
    default:
      return assertNever(input.outcome.kind)
  }
}

async function writeIterationEvidence(
  evidenceDir: string,
  evidence: OppStressRampEvidence
): Promise<void> {
  await Fs.promises.writeFile(
    Path.join(evidenceDir, `iteration-${evidence.iterationIndex}.json`),
    `${JSON.stringify(evidence, jsonReplacer, 2)}\n`
  )
}

function maxStatus(
  campaignSaturation: CampaignSaturation
): "partial_saturation" | "saturation_not_reached" {
  return campaignSaturation.saturatedEndpoints.length === 0
    ? "saturation_not_reached"
    : "partial_saturation"
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value
}

function assertRampConfig(config: OppStressRampConfig): void {
  if (!positiveInteger(config.initialCount))
    throw new RangeError("initialCount must be positive")
  if (!positiveInteger(config.multiplier) || config.multiplier <= 1) {
    throw new RangeError("multiplier must be greater than 1")
  }
  if (
    !positiveInteger(config.maxCount) ||
    config.maxCount < config.initialCount
  ) {
    throw new RangeError(
      "maxCount must be greater than or equal to initialCount"
    )
  }
  if (!positiveInteger(config.phaseTimeoutMs))
    throw new RangeError("phaseTimeoutMs must be positive")
}

function positiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

function assertNever(value: never): never {
  throw new Error(`Unexpected OPP stress ramp outcome: ${String(value)}`)
}
