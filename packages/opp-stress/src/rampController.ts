import * as Fs from "node:fs"
import {
  emptyCampaignSaturation,
  mergeCampaignSaturation,
  type CampaignSaturation
} from "./campaignSaturation.js"
import {
  type OppStressRampConfig,
  type OppStressRampEvidence,
  type OppStressRampOptions,
  type OppStressRampResult
} from "./rampControllerTypes.js"
export {
  OppStressRampDefaults,
  type OppStressRampConfig,
  type OppStressRampIterationInput,
  type OppStressRampIterationOutcome,
  type OppStressRampEvidence,
  type OppStressRampResultStatus,
  type OppStressRampResult,
  type OppStressRampOptions
} from "./rampControllerTypes.js"
import {
  assertRampConfig,
  defaultRampConfig
} from "./rampControllerConfig.js"
import {
  evidenceFromOutcome,
  maxStatus,
  writeIterationEvidence
} from "./rampEvidence.js"

type RampState = {
  readonly accountCount: number
  readonly iterationIndex: number
  readonly priorIterations: readonly OppStressRampEvidence[]
  readonly priorSaturation: CampaignSaturation
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
      outcome.kind !== "breakage" && state.accountCount >= config.maxCount
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

function assertNever(value: never): never {
  throw new Error(`Unexpected OPP stress ramp outcome: ${String(value)}`)
}
