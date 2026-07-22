import Path from "node:path"

import { canonicalEvidenceJson } from "./canonicalEvidenceJson.js"
import { evidenceSha256 } from "./oppArtifactAcceptance.js"
import { RunEvidenceClusterConfigState, RunEvidencePath } from "./runEvidenceConstants.js"
import type {
  RunEvidenceArtifact,
  RunEvidenceClusterConfigSnapshot,
  RunEvidenceIterationRecordRef,
  RunEvidenceSetupRecordRef,
  RunEvidenceTerminalRecordRef
} from "./RunEvidenceCoreTypes.js"
import type { RunEvidenceManifest } from "./RunEvidenceManifestTypes.js"
import type {
  RunEvidenceIteration,
  RunEvidenceSetup,
  RunEvidenceTerminal
} from "./RunEvidenceRecordTypes.js"
import { terminalManifest } from "./runEvidenceManifestBuilders.js"
import type { RunEvidencePublicationCoordinator } from "./RunEvidencePublicationCoordinator.js"
import {
  invalidPersistenceState,
  requireCommittedPersistenceSetup,
  requireCommittedPersistenceSetupRef,
  requirePersistenceTerminal,
  requirePersistenceTerminalAgreement
} from "./runEvidencePersistenceValidation.js"

/** Mutable store state required to publish one terminal decision atomically. */
export type RunEvidenceTerminalPersistenceContext = {
  readonly runDirectory: string
  readonly coordinator: RunEvidencePublicationCoordinator
  readonly manifest: () => RunEvidenceManifest
  readonly setup: () => RunEvidenceSetup | null
  readonly setupRef: () => RunEvidenceSetupRecordRef | null
  readonly iterationRefs: () => readonly RunEvidenceIterationRecordRef[]
  readonly iterations: () => readonly RunEvidenceIteration[]
  readonly terminalRef: () => RunEvidenceTerminalRecordRef | null
  readonly config: () => RunEvidenceClusterConfigSnapshot | null
  readonly artifacts: () => readonly RunEvidenceArtifact[]
  readonly commit: (
    ref: RunEvidenceTerminalRecordRef,
    manifest: RunEvidenceManifest
  ) => void
}

/** Publish terminal bytes and their matching manifest checkpoint from one decision. */
export function publishRunEvidenceTerminal(
  context: RunEvidenceTerminalPersistenceContext,
  input: unknown
): Promise<RunEvidenceTerminalRecordRef> {
  return context.coordinator.exclusive(async () => {
    context.coordinator.requireOpen()
    if (context.terminalRef() !== null)
      throw invalidPersistenceState("terminal.json is already committed")
    const terminal = requirePersistenceTerminal(input),
      setup = requireCommittedPersistenceSetup(context.setup()),
      setupRef = requireCommittedPersistenceSetupRef(context.setupRef()),
      iterationRefs = context.iterationRefs(),
      iterations = context.iterations()
    requirePersistenceTerminalAgreement({
      manifest: context.manifest(),
      setup,
      iterationRefs,
      iterations,
      terminal
    })
    const bytes = canonicalEvidenceJson(terminal),
      ref: RunEvidenceTerminalRecordRef = {
        path: RunEvidencePath.Terminal,
        sha256: evidenceSha256(bytes)
      }
    await context.coordinator.publishImmutable({
      finalFile: Path.join(context.runDirectory, ref.path),
      data: bytes
    })
    const next = terminalManifest({
      manifest: context.manifest(),
      setup,
      setupRef,
      iterationRefs,
      terminal,
      terminalRef: ref,
      config: context.config() ?? { kind: RunEvidenceClusterConfigState.Pending },
      artifacts: context.artifacts()
    })
    await context.coordinator.replaceAfterImmutable(next)
    context.commit(ref, next)
    return ref
  })
}
