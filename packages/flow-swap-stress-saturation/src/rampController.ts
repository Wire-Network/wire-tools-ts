import {
  OppStressRampEvidenceModeKind,
  RunEvidenceEndpoint,
  runOppStressRamp
} from "@wireio/test-opp-stress"
import type { OppStressRampEvidence } from "@wireio/test-opp-stress"

import { parseSwapStressObservationEvidence } from "./flowObservationEvidenceParser.js"
import { persistedSwapStressObservation } from "./flowRunEvidenceAdapter.js"
import { StressRampDefaults } from "./rampControllerTypes.js"
import type {
  StressRampOptions,
  StressRampResult
} from "./rampControllerTypes.js"

export { StressRampDefaults } from "./rampControllerTypes.js"
export type {
  StressRampConfig,
  StressRampEvidence,
  StressRampIterationInput,
  StressRampOptions,
  StressRampResult
} from "./rampControllerTypes.js"

/**
 * Run stress iterations until both Ethereum OPP directions saturate, breakage, or max count.
 *
 * @param options Ramp config, clock, and observation-only iteration runner.
 * @returns Final ramp status plus in-memory evidence records.
 */
export async function runSaturationRamp(
  options: StressRampOptions
): Promise<StressRampResult> {
  const persistence = options.persistence
  if (persistence !== undefined)
    return runPersistedSaturationRamp({ ...options, persistence })
  return runOppStressRamp({
    evidenceMode: OppStressRampEvidenceModeKind.DeferredFlowMigration,
    config: options.config ?? defaultRampConfig(),
    requiredEndpoints: requiredEndpointNames(),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    parseEvidence: parseSwapStressObservationEvidence,
    runIteration: options.runIteration
  })
}

async function runPersistedSaturationRamp(
  options: StressRampOptions & {
    readonly persistence: NonNullable<StressRampOptions["persistence"]>
  }
): Promise<StressRampResult> {
  const observations = new Map<number, Awaited<ReturnType<typeof options.runIteration>>>()
  const result = await runOppStressRamp({
    evidenceMode: OppStressRampEvidenceModeKind.SchemaV1,
    persistence: options.persistence,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    runIteration: async input => {
      const observation = await options.runIteration(input),
        persisted = persistedSwapStressObservation(
          observation,
          requiredEndpointNames()
        )
      observations.set(input.iterationIndex, observation)
      return persisted
    }
  })
  return {
    ...result,
    iterations: result.iterations.map(summary =>
      flowIterationSummary(summary, observations.get(summary.iterationIndex))
    )
  }
}

function flowIterationSummary(
  summary: OppStressRampEvidence,
  observation: Awaited<ReturnType<StressRampOptions["runIteration"]>> | undefined
): StressRampResult["iterations"][number] {
  if (summary.observation === null) {
    if (summary.kind !== "breakage")
      throw new TypeError("boundary failure requires breakage authority")
    return {
      iterationIndex: summary.iterationIndex,
      accountCount: summary.accountCount,
      startedAtMs: summary.startedAtMs,
      endedAtMs: summary.endedAtMs,
      status: summary.status,
      preserveCluster: summary.preserveCluster,
      config: summary.config,
      saturatedEndpoints: summary.saturatedEndpoints,
      missingEndpoints: summary.missingEndpoints,
      observedNonRequiredEndpoints: summary.observedNonRequiredEndpoints,
      kind: "breakage",
      observation: null,
      breakageCategory: summary.breakageCategory,
      breakageReason: summary.breakageReason,
      telemetry: summary.telemetry,
      cause: summary.cause
    }
  }
  if (observation === undefined)
    throw new TypeError("accepted flow observation is unavailable")
  const fields = {
    iterationIndex: summary.iterationIndex,
    accountCount: summary.accountCount,
    startedAtMs: summary.startedAtMs,
    endedAtMs: summary.endedAtMs,
    status: summary.status,
    preserveCluster: summary.preserveCluster,
    config: summary.config,
    saturatedEndpoints: summary.saturatedEndpoints,
    missingEndpoints: summary.missingEndpoints,
    observedNonRequiredEndpoints: summary.observedNonRequiredEndpoints
  }
  if (summary.kind === "breakage") {
    if (observation.kind !== "breakage")
      throw new TypeError("accepted breakage summary requires flow breakage")
    return {
      ...fields,
      kind: "breakage",
      observation,
      breakageCategory: summary.breakageCategory,
      breakageReason: summary.breakageReason
    }
  }
  if (observation.kind !== "completed")
    throw new TypeError("accepted completed summary requires completed flow")
  return {
    ...fields,
    kind: summary.kind,
    observation
  }
}

function defaultRampConfig(): NonNullable<StressRampOptions["config"]> {
  return {
    initialCount: StressRampDefaults.InitialCount,
    multiplier: StressRampDefaults.Multiplier,
    maxCount: StressRampDefaults.MaxCount,
    phaseTimeoutMs: StressRampDefaults.PhaseTimeoutMs
  }
}

function requiredEndpointNames(): readonly RunEvidenceEndpoint[] {
  return [
    RunEvidenceEndpoint.OutpostEthereumDepot,
    RunEvidenceEndpoint.DepotOutpostEthereum
  ]
}
