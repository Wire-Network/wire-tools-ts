import {
  RunEvidenceIterationOutcome,
  RunEvidencePhaseStatus,
  type RunEvidenceEndpoint,
  type RunEvidenceEndpointResult,
  type RunEvidenceIteration,
  type RunEvidenceManifest,
  type RunEvidenceSetup,
  type RunEvidenceTerminal
} from "../runEvidenceTypes.js"
import {
  RunEvidenceVerificationIssueCode,
  type RunEvidenceRecomputedEndpoint,
  type RunEvidenceRecomputedIteration
} from "../runEvidenceVerifierTypes.js"
import type { VerifiedEvidenceArtifacts } from "./evidenceArtifacts.js"
import {
  campaignEndpointResults,
  verifyRetainedEndpointResults,
  type RetainedEndpointResults
} from "./evidenceEndpointResults.js"
import { verifyEvidenceLifecycle } from "./evidenceLifecycle.js"
import { recomputeEvidencePhase } from "./evidenceMetrics.js"
import { RunEvidenceVerificationContext } from "./verifierIssues.js"

/** Full independently recomputed iteration and campaign state. */
export type EvidenceCampaignRecomputation = {
  readonly iterations: readonly RunEvidenceRecomputedIteration[]
  readonly endpoints: readonly RunEvidenceRecomputedEndpoint[]
}

/** Recompute iteration partitions, account ramp, and terminal campaign state. */
export function recomputeEvidenceCampaign(
  manifest: RunEvidenceManifest,
  setup: RunEvidenceSetup | null,
  iterations: readonly RunEvidenceIteration[],
  terminal: RunEvidenceTerminal | null,
  artifacts: VerifiedEvidenceArtifacts,
  context: RunEvidenceVerificationContext
): EvidenceCampaignRecomputation {
  const saturated = new Set<RunEvidenceEndpoint>(),
    supporting = new Map<RunEvidenceEndpoint, string[]>(),
    retainedEndpointResults: RetainedEndpointResults = new Map(),
    expectedEndpointResults: (readonly RunEvidenceEndpointResult[])[] = [],
    recomputed = iterations.map((iteration, index) => {
      verifyAccountRamp(manifest, iterations, index, context)
      const path = manifest.records.iterations[index]?.path ?? "$run",
        phases = iteration.phases.map(phase =>
          recomputeEvidencePhase(phase, artifacts, path, context)
        ),
        newlySaturated = manifest.requiredEndpoints.filter(endpoint =>
          phases.some(
            (phase, phaseIndex) =>
              phase.endpoint === endpoint &&
              phase.saturated &&
              iteration.phases[phaseIndex]?.status ===
                RunEvidencePhaseStatus.Completed
          )
        )
      newlySaturated.forEach(endpoint => {
        saturated.add(endpoint)
        const labels = phases
          .filter(
            (phase, phaseIndex) =>
              phase.endpoint === endpoint &&
              phase.saturated &&
              iteration.phases[phaseIndex]?.status ===
                RunEvidencePhaseStatus.Completed
          )
          .map(phase => `${index}:${phase.label}`)
        supporting.set(endpoint, [
          ...(supporting.get(endpoint) ?? []),
          ...labels.filter(
            label => !(supporting.get(endpoint) ?? []).includes(label)
          )
        ])
      })
      const iterationSaturated = manifest.requiredEndpoints.filter(endpoint =>
          saturated.has(endpoint)
        ),
        missing = manifest.requiredEndpoints.filter(
          endpoint => !saturated.has(endpoint)
        ),
        expectedResults = campaignEndpointResults(
          manifest.requiredEndpoints,
          iteration,
          newlySaturated,
          retainedEndpointResults
        )
      expectedEndpointResults.push(expectedResults)
      verifyRetainedEndpointResults(
        iteration.endpointResults,
        expectedResults,
        path,
        context
      )
      compareIteration(iteration, iterationSaturated, missing, path, context)
      if (
        saturated.size === manifest.requiredEndpoints.length &&
        index < iterations.length - 1
      )
        context.issue(
          RunEvidenceVerificationIssueCode.CampaignMismatch,
          path,
          "iterations continue after all required endpoints independently saturated"
        )
      return {
        iterationIndex: iteration.iterationIndex,
        accountCount: iteration.accountCount,
        saturatedEndpoints: iterationSaturated,
        missingEndpoints: missing,
        phases
      }
    }),
    endpoints = manifest.requiredEndpoints.map(endpoint => ({
      endpoint,
      saturated: saturated.has(endpoint),
      supportingPhases: supporting.get(endpoint) ?? []
    })),
    campaignSaturated = manifest.requiredEndpoints.filter(endpoint =>
      saturated.has(endpoint)
    ),
    campaignMissing = manifest.requiredEndpoints.filter(
      endpoint => !saturated.has(endpoint)
    )
  verifyEvidenceLifecycle(
    manifest,
    setup,
    iterations,
    terminal,
    campaignSaturated,
    campaignMissing,
    expectedEndpointResults.at(-1) ?? null,
    context
  )
  return { iterations: recomputed, endpoints }
}

function verifyAccountRamp(
  manifest: RunEvidenceManifest,
  iterations: readonly RunEvidenceIteration[],
  index: number,
  context: RunEvidenceVerificationContext
): void {
  const previous = iterations[index - 1],
    expected =
      previous === undefined
        ? manifest.rampConfig.initialCount
        : Number(
            minimum(
              BigInt(previous.accountCount) *
                BigInt(manifest.rampConfig.multiplier),
              BigInt(manifest.rampConfig.maxCount)
            )
          ),
    current = iterations[index]
  if (current?.accountCount !== expected)
    context.issue(
      RunEvidenceVerificationIssueCode.AccountRampMismatch,
      manifest.records.iterations[index]?.path ?? "$run",
      `account count ${current?.accountCount ?? "missing"} differs from ${expected}`
    )
}

function compareIteration(
  iteration: RunEvidenceIteration,
  saturated: readonly RunEvidenceEndpoint[],
  missing: readonly RunEvidenceEndpoint[],
  path: string,
  context: RunEvidenceVerificationContext
): void {
  const cleanOutcome =
    missing.length === 0
      ? RunEvidenceIterationOutcome.Saturated
      : RunEvidenceIterationOutcome.NotSaturated
  if (
    !sameEndpoints(iteration.saturatedEndpoints, saturated) ||
    !sameEndpoints(iteration.missingEndpoints, missing) ||
    iteration.endpointResults.some(
      result => result.saturated !== saturated.includes(result.endpoint)
    ) ||
    (iteration.outcome !== RunEvidenceIterationOutcome.Breakage &&
      iteration.outcome !== cleanOutcome)
  )
    context.issue(
      RunEvidenceVerificationIssueCode.IterationMismatch,
      path,
      "recorded outcome or endpoint partition differs from completed phase bytes"
    )
}

function sameEndpoints(
  left: readonly RunEvidenceEndpoint[],
  right: readonly RunEvidenceEndpoint[]
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  )
}

function minimum(left: bigint, right: bigint): bigint {
  return left < right ? left : right
}
