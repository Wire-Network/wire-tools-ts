import {
  RunEvidencePath,
  type RunEvidenceEndpoint
} from "@wireio/test-opp-stress"

import {
  arrayField,
  objectField,
  readVerifierJson,
  recordValue,
  refreshVerifierRecordHash,
  writeVerifierJson
} from "./runEvidenceVerifierTestSupport.js"

/**
 * Mutate the first persisted phase and refresh every dependent record hash.
 * @param runDirectory Persisted verifier fixture root.
 * @param mutate Mutation applied to the first phase object.
 */
export function mutateVerifierFirstPhase(
  runDirectory: string,
  mutate: (phase: Record<string, unknown>) => void
): void {
  mutateVerifierIteration(runDirectory, iteration => {
    mutate(recordValue(arrayField(iteration, "phases")[0]))
  })
}

/**
 * Mutate iteration zero and refresh its manifest and terminal references.
 * @param runDirectory Persisted verifier fixture root.
 * @param mutate Mutation applied to iteration zero.
 */
export function mutateVerifierIteration(
  runDirectory: string,
  mutate: (iteration: Record<string, unknown>) => void
): void {
  const path = `${RunEvidencePath.Iterations}/000000.json`,
    iteration = readVerifierJson(runDirectory, path)
  mutate(iteration)
  writeVerifierJson(runDirectory, path, iteration)
  refreshVerifierRecordHash(runDirectory, path)
  const manifest = readVerifierJson(runDirectory, RunEvidencePath.Manifest),
    refs = arrayField(objectField(manifest, "records"), "iterations"),
    terminal = readVerifierJson(runDirectory, RunEvidencePath.Terminal)
  terminal["iterationRefs"] = refs
  writeVerifierJson(runDirectory, RunEvidencePath.Terminal, terminal)
  refreshVerifierRecordHash(runDirectory, RunEvidencePath.Terminal)
}

/**
 * Assign a canonical endpoint claim to one mutable phase fixture.
 * @param phase Mutable persisted phase object.
 * @param endpoint Canonical forged endpoint claim.
 */
export function forgePhaseEndpoint(
  phase: Record<string, unknown>,
  endpoint: RunEvidenceEndpoint
): void {
  phase["endpoint"] = endpoint
}
