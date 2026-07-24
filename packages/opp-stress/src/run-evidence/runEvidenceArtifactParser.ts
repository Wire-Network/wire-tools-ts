import { RunEvidenceRecordKind } from "./runEvidenceConstants.js"
import type {
  RunEvidenceArtifact,
  RunEvidenceParseResult,
  RunEvidenceProvenance
} from "./RunEvidenceCoreTypes.js"
import { isArtifact, isProvenance } from "./runEvidenceArtifactGuards.js"
import { parseEvidence } from "./runEvidencePrimitiveGuards.js"

/**
 * Parse an unknown value as a schema-v1 immutable artifact entry.
 * @param input Unknown boundary value to parse.
 * @returns Typed success with the artifact or a stable parse failure.
 */
export function parseRunEvidenceArtifact(
  input: unknown
): RunEvidenceParseResult<RunEvidenceArtifact> {
  return parseEvidence(input, RunEvidenceRecordKind.Artifact, isArtifact)
}

/**
 * Parse unknown source paths as normalized schema-v1 provenance.
 * @param input Unknown boundary value to parse.
 * @returns Typed success with provenance or a stable parse failure.
 */
export function parseRunEvidenceProvenance(
  input: unknown
): RunEvidenceParseResult<RunEvidenceProvenance> {
  return parseEvidence(input, RunEvidenceRecordKind.Provenance, isProvenance)
}
