import * as Fs from "node:fs"
import * as Path from "node:path"

import {
  emptyCampaignSaturation,
  mergeCampaignSaturation,
  type CampaignSaturation
} from "./rampCampaignSaturation.js"
import { StressRampDefaults } from "./rampControllerTypes.js"
import type {
  StressRampConfig,
  StressRampEvidence,
  StressRampIterationOutcome,
  StressRampOptions,
  StressRampResult
} from "./rampControllerTypes.js"

export { StressRampDefaults } from "./rampControllerTypes.js"
export type {
  StressRampConfig,
  StressRampEvidence,
  StressRampIterationInput,
  StressRampIterationOutcome,
  StressRampOptions,
  StressRampResult
} from "./rampControllerTypes.js"

/**
 * Run stress iterations until saturation, pre-saturation breakage, or max count.
 *
 * @param options Evidence directory, ramp config, and iteration runner.
 * @returns Final ramp status plus in-memory evidence records.
 */
export async function runSaturationRamp(
  options: StressRampOptions
): Promise<StressRampResult> {
  const config = options.config ?? defaultRampConfig()
  assertRampConfig(config)
  await Fs.promises.mkdir(options.evidenceDir, { recursive: true })
  return runRampAtCount(
    options,
    config,
    config.initialCount,
    0,
    [],
    emptyCampaignSaturation()
  )
}

function defaultRampConfig(): StressRampConfig {
  return {
    initialCount: StressRampDefaults.InitialCount,
    multiplier: StressRampDefaults.Multiplier,
    maxCount: StressRampDefaults.MaxCount,
    phaseTimeoutMs: StressRampDefaults.PhaseTimeoutMs
  }
}

async function runRampAtCount(
  options: StressRampOptions,
  config: StressRampConfig,
  accountCount: number,
  iterationIndex: number,
  priorIterations: readonly StressRampEvidence[],
  priorSaturation: CampaignSaturation
): Promise<StressRampResult> {
  const outcome = await options.runIteration({
      iterationIndex,
      accountCount,
      phaseTimeoutMs: config.phaseTimeoutMs
    }),
    campaignSaturation = mergeCampaignSaturation(priorSaturation, outcome),
    reachedMaxCount = accountCount >= config.maxCount,
    finalMaxStatus = maxCountStatus(
      outcome.kind,
      reachedMaxCount,
      campaignSaturation
    ),
    evidence = evidenceFromOutcome(
      outcome,
      config,
      campaignSaturation,
      finalMaxStatus
    )
  await writeIterationEvidence(options.evidenceDir, evidence)
  const iterations = [...priorIterations, evidence]
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
      return {
        status: "partial_saturation",
        preserveCluster: true,
        iterations,
        ...campaignSaturation
      }
    case "not_saturated":
      return reachedMaxCount
        ? {
            status:
              campaignSaturation.saturatedEndpoints.length === 0
                ? "saturation_not_reached"
                : "partial_saturation",
            preserveCluster: true,
            iterations,
            ...campaignSaturation
          }
        : runRampAtCount(
            options,
            config,
            Math.min(accountCount * config.multiplier, config.maxCount),
            iterationIndex + 1,
            iterations,
            campaignSaturation
          )
  }
}

function evidenceFromOutcome(
  outcome: StressRampIterationOutcome,
  config: StressRampConfig,
  campaignSaturation: CampaignSaturation,
  finalMaxStatus: "partial_saturation" | "saturation_not_reached" | null
): StressRampEvidence {
  switch (outcome.kind) {
    case "saturated":
      return campaignSaturation.missingEndpoints.length === 0
        ? {
            ...outcome,
            ...campaignSaturation,
            status: "saturated",
            preserveCluster: false,
            config
          }
        : {
            ...outcome,
            ...campaignSaturation,
            status: "partial_saturation",
            preserveCluster: true,
            config
          }
    case "breakage":
      return {
        ...outcome,
        ...campaignSaturation,
        status: "failed_before_saturation",
        preserveCluster: true,
        config
      }
    case "not_saturated":
      return {
        ...outcome,
        ...campaignSaturation,
        status:
          campaignSaturation.missingEndpoints.length === 0
            ? "saturated"
            : (finalMaxStatus ?? "not_saturated"),
        preserveCluster: finalMaxStatus !== null,
        config
      }
  }
}

function maxCountStatus(
  kind: StressRampIterationOutcome["kind"],
  reachedMaxCount: boolean,
  campaignSaturation: CampaignSaturation
): "partial_saturation" | "saturation_not_reached" | null {
  if (
    !reachedMaxCount ||
    kind === "breakage" ||
    campaignSaturation.missingEndpoints.length === 0
  ) {
    return null
  }
  return campaignSaturation.saturatedEndpoints.length === 0
    ? "saturation_not_reached"
    : "partial_saturation"
}

async function writeIterationEvidence(
  evidenceDir: string,
  evidence: StressRampEvidence
): Promise<void> {
  await Fs.promises.writeFile(
    Path.join(evidenceDir, `iteration-${evidence.iterationIndex}.json`),
    `${JSON.stringify(evidence, jsonReplacer, 2)}\n`
  )
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value
}

function assertRampConfig(config: StressRampConfig): void {
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
