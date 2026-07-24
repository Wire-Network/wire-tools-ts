import type { RunEvidencePersistence } from "../runEvidencePersistence.js"
import { RunEvidenceSetupStatus } from "./runEvidenceConstants.js"
import type { RunEvidenceIterationRecordRef } from "./RunEvidenceCoreTypes.js"
import type { RunEvidenceManifest } from "./RunEvidenceManifestTypes.js"
import type { RunEvidenceSetup } from "./RunEvidenceRecordTypes.js"
import { invalidPersistenceState } from "./runEvidencePersistenceValidation.js"

/** State needed to prove a fresh successful setup is ready for one ramp. */
export type ActiveRampContextState = {
  readonly manifest: RunEvidenceManifest
  readonly setup: RunEvidenceSetup | null
  readonly idle: boolean
  readonly terminalCommitted: boolean
  readonly iterationRefs: readonly RunEvidenceIterationRecordRef[]
}

/** Require and freeze the allocation authority for a fresh active ramp. */
export function activeRampContext(
  state: ActiveRampContextState
): RunEvidencePersistence.ActiveRampContext {
  if (
    state.setup?.status !== RunEvidenceSetupStatus.Succeeded ||
    !state.idle ||
    state.terminalCommitted ||
    state.iterationRefs.length !== 0
  )
    throw invalidPersistenceState(
      "ramp context requires fresh active successful setup"
    )
  return Object.freeze({
    startedAtMs: state.manifest.startedAtMs,
    rampConfig: Object.freeze({ ...state.manifest.rampConfig }),
    requiredEndpoints: Object.freeze([...state.manifest.requiredEndpoints])
  })
}
