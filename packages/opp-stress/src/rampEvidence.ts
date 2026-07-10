import * as Fs from "node:fs"
import * as Path from "node:path"

import type { CampaignSaturation } from "./campaignSaturation.js"
import type {
  OppStressRampConfig,
  OppStressRampEvidence,
  OppStressRampIterationOutcome
} from "./rampControllerTypes.js"

type EvidenceInput = {
  readonly outcome: OppStressRampIterationOutcome
  readonly config: OppStressRampConfig
  readonly campaignSaturation: CampaignSaturation
  readonly finalMaxStatus:
    "partial_saturation" | "saturation_not_reached" | null
}

/**
 * Create persisted evidence for one ramp iteration from its outcome and campaign state.
 *
 * @param input Outcome, active config, campaign aggregation, and max-count status.
 * @returns Complete evidence record ready for JSON persistence.
 */
export function evidenceFromOutcome(input: EvidenceInput): OppStressRampEvidence {
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

/**
 * Persist one iteration evidence file under the ramp evidence directory.
 *
 * @param evidenceDir Directory that stores per-iteration evidence JSON files.
 * @param evidence Complete iteration evidence payload.
 */
export async function writeIterationEvidence(
  evidenceDir: string,
  evidence: OppStressRampEvidence
): Promise<void> {
  await Fs.promises.writeFile(
    Path.join(evidenceDir, `iteration-${evidence.iterationIndex}.json`),
    `${JSON.stringify(evidence, jsonReplacer, 2)}\n`
  )
}

/**
 * Classify a max-count stop from current campaign endpoint saturation.
 *
 * @param campaignSaturation Required and diagnostic endpoint aggregation.
 * @returns Partial saturation when any required endpoint saturated, otherwise not reached.
 */
export function maxStatus(
  campaignSaturation: CampaignSaturation
): "partial_saturation" | "saturation_not_reached" {
  return campaignSaturation.saturatedEndpoints.length === 0
    ? "saturation_not_reached"
    : "partial_saturation"
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value
}

function assertNever(value: never): never {
  throw new Error(`Unexpected OPP stress ramp outcome: ${String(value)}`)
}
