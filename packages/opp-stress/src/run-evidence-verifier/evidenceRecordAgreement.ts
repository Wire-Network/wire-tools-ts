import {
  RunEvidenceClusterConfigState,
  RunEvidenceLifecycle,
  RunEvidencePath,
  RunEvidenceSetupStatus,
  type RunEvidenceIteration,
  type RunEvidenceManifest,
  type RunEvidenceSetup,
  type RunEvidenceTerminal
} from "../runEvidenceTypes.js"
import { RunEvidenceVerificationIssueCode } from "../runEvidenceVerifierTypes.js"
import { RunEvidenceVerificationContext } from "./verifierIssues.js"

type RecordRef = { readonly path: string; readonly sha256: string }

/** Verify cross-record identity, lifecycle, endpoint, and chronology agreement. */
export function verifyEvidenceRecordAgreement(
  manifest: RunEvidenceManifest,
  setup: RunEvidenceSetup | null,
  iterations: readonly RunEvidenceIteration[],
  terminal: RunEvidenceTerminal | null,
  context: RunEvidenceVerificationContext
): void {
  iterations.forEach((iteration, index) => {
    if (iteration.iterationIndex !== index)
      context.issue(
        RunEvidenceVerificationIssueCode.IterationMismatch,
        manifest.records.iterations[index]?.path ?? "$run",
        `record index ${iteration.iterationIndex} differs from path index ${index}`
      )
    if (!sameStrings(iteration.requiredEndpoints, manifest.requiredEndpoints))
      context.issue(
        RunEvidenceVerificationIssueCode.ReferenceMismatch,
        manifest.records.iterations[index]?.path ?? "$run",
        "iteration required endpoints differ from manifest"
      )
  })
  verifySetupAgreement(manifest, setup, context)
  verifyTerminalAgreement(manifest, terminal, context)
  verifyChronology(manifest, setup, iterations, terminal, context)
}

function verifySetupAgreement(
  manifest: RunEvidenceManifest,
  setup: RunEvidenceSetup | null,
  context: RunEvidenceVerificationContext
): void {
  if (setup === null) return
  const captured =
    manifest.clusterConfigSnapshot.kind ===
    RunEvidenceClusterConfigState.Captured
  if (setup.clusterConfigCreated !== captured)
    context.issue(
      RunEvidenceVerificationIssueCode.LifecycleMismatch,
      RunEvidencePath.Setup,
      "setup config-created claim differs from manifest snapshot state"
    )
  const setupFailed = manifest.lifecycle === RunEvidenceLifecycle.SetupFailed
  if (setupFailed !== (setup.status === RunEvidenceSetupStatus.Failed))
    context.issue(
      RunEvidenceVerificationIssueCode.LifecycleMismatch,
      RunEvidencePath.Setup,
      "setup outcome differs from manifest lifecycle"
    )
}

function verifyTerminalAgreement(
  manifest: RunEvidenceManifest,
  terminal: RunEvidenceTerminal | null,
  context: RunEvidenceVerificationContext
): void {
  if (terminal === null) return
  if (
    terminal.lifecycle !== manifest.lifecycle ||
    terminal.preserveCluster !== manifest.preserveCluster ||
    !sameStrings(terminal.requiredEndpoints, manifest.requiredEndpoints) ||
    !sameRefs(terminal.iterationRefs, manifest.records.iterations)
  )
    context.issue(
      RunEvidenceVerificationIssueCode.TerminalMismatch,
      RunEvidencePath.Terminal,
      "terminal lifecycle, preservation, endpoints, or iteration refs differ"
    )
}

function verifyChronology(
  manifest: RunEvidenceManifest,
  setup: RunEvidenceSetup | null,
  iterations: readonly RunEvidenceIteration[],
  terminal: RunEvidenceTerminal | null,
  context: RunEvidenceVerificationContext
): void {
  if (
    setup !== null &&
    BigInt(setup.startedAtMs) < BigInt(manifest.startedAtMs)
  )
    chronologyIssue(
      context,
      RunEvidencePath.Setup,
      "setup starts before run allocation"
    )
  iterations.forEach((iteration, index) => {
    const previousEnd =
      index === 0 ? setup?.endedAtMs : iterations[index - 1]?.endedAtMs
    if (
      previousEnd !== undefined &&
      BigInt(iteration.startedAtMs) < BigInt(previousEnd)
    )
      chronologyIssue(
        context,
        manifest.records.iterations[index]?.path ?? "$run",
        "iteration starts before the preceding lifecycle stage ended"
      )
  })
  if (terminal === null) return
  const lastEnd =
    iterations.at(-1)?.endedAtMs ?? setup?.endedAtMs ?? manifest.startedAtMs
  if (
    terminal.startedAtMs !== manifest.startedAtMs ||
    BigInt(terminal.endedAtMs) < BigInt(lastEnd) ||
    BigInt(manifest.updatedAtMs) < BigInt(terminal.endedAtMs)
  )
    chronologyIssue(
      context,
      RunEvidencePath.Terminal,
      "terminal allocation/end timestamps disagree with lifecycle order"
    )
}

function chronologyIssue(
  context: RunEvidenceVerificationContext,
  path: string,
  detail: string
): void {
  context.issue(
    RunEvidenceVerificationIssueCode.LifecycleMismatch,
    path,
    detail
  )
}

function sameStrings(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  )
}

function sameRefs(
  left: readonly RecordRef[],
  right: readonly RecordRef[]
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (value, index) =>
        value.path === right[index]?.path &&
        value.sha256 === right[index]?.sha256
    )
  )
}
