import {
  RunEvidenceIterationOutcome,
  RunEvidenceLifecycle,
  RunEvidencePath,
  RunEvidenceSetupStatus,
  type RunEvidenceEndpoint,
  type RunEvidenceEndpointResult,
  type RunEvidenceIteration,
  type RunEvidenceManifest,
  type RunEvidenceSetup,
  type RunEvidenceTerminal
} from "../runEvidenceTypes.js"
import { RunEvidenceVerificationIssueCode } from "../runEvidenceVerifierTypes.js"
import { sameEndpointResults } from "./evidenceEndpointResults.js"
import { RunEvidenceVerificationContext } from "./verifierIssues.js"

/** Compare recomputed campaign partitions with manifest and terminal lifecycle. */
export function verifyEvidenceLifecycle(
  manifest: RunEvidenceManifest,
  setup: RunEvidenceSetup | null,
  iterations: readonly RunEvidenceIteration[],
  terminal: RunEvidenceTerminal | null,
  saturated: readonly RunEvidenceEndpoint[],
  missing: readonly RunEvidenceEndpoint[],
  expectedEndpointResults: readonly RunEvidenceEndpointResult[] | null,
  context: RunEvidenceVerificationContext
): void {
  const partitionMatches =
    sameEndpoints(manifest.saturatedEndpoints, saturated) &&
    sameEndpoints(manifest.missingEndpoints, missing)
  if (
    !partitionMatches &&
    manifest.lifecycle !== RunEvidenceLifecycle.Initializing
  )
    context.issue(
      RunEvidenceVerificationIssueCode.ManifestMismatch,
      RunEvidencePath.Manifest,
      "manifest endpoint partition differs from independently recomputed campaign"
    )
  verifyTerminalPartition(
    terminal,
    saturated,
    missing,
    expectedEndpointResults,
    context
  )
  verifyLifecycleVariant(
    manifest,
    setup,
    iterations,
    terminal,
    missing,
    context
  )
}

function verifyTerminalPartition(
  terminal: RunEvidenceTerminal | null,
  saturated: readonly RunEvidenceEndpoint[],
  missing: readonly RunEvidenceEndpoint[],
  expectedEndpointResults: readonly RunEvidenceEndpointResult[] | null,
  context: RunEvidenceVerificationContext
): void {
  if (terminal === null) return
  if (
    !sameEndpoints(terminal.saturatedEndpoints, saturated) ||
    !sameEndpoints(terminal.missingEndpoints, missing) ||
    terminal.endpointResults.some(
      result => result.saturated !== saturated.includes(result.endpoint)
    )
  )
    context.issue(
      RunEvidenceVerificationIssueCode.TerminalMismatch,
      RunEvidencePath.Terminal,
      "terminal endpoint partition differs from independently recomputed campaign"
    )
  if (
    expectedEndpointResults !== null &&
    !sameEndpointResults(terminal.endpointResults, expectedEndpointResults)
  )
    context.issue(
      RunEvidenceVerificationIssueCode.TerminalMismatch,
      RunEvidencePath.Terminal,
      "terminal endpoint results differ from the final campaign state"
    )
}

function verifyLifecycleVariant(
  manifest: RunEvidenceManifest,
  setup: RunEvidenceSetup | null,
  iterations: readonly RunEvidenceIteration[],
  terminal: RunEvidenceTerminal | null,
  missing: readonly RunEvidenceEndpoint[],
  context: RunEvidenceVerificationContext
): void {
  const last = iterations.at(-1)
  switch (manifest.lifecycle) {
    case RunEvidenceLifecycle.Initializing:
      return
    case RunEvidenceLifecycle.Running:
      if (
        terminal !== null ||
        missing.length === 0 ||
        last?.outcome === RunEvidenceIterationOutcome.Breakage
      )
        lifecycleIssue(
          context,
          "running evidence already has a terminal condition"
        )
      return
    case RunEvidenceLifecycle.SetupFailed:
      if (
        setup?.status !== RunEvidenceSetupStatus.Failed ||
        iterations.length !== 0 ||
        terminal?.lifecycle !== RunEvidenceLifecycle.SetupFailed
      )
        lifecycleIssue(
          context,
          "setup-failed evidence does not end at failed setup"
        )
      return
    case RunEvidenceLifecycle.Failed:
      if (
        last?.outcome !== RunEvidenceIterationOutcome.Breakage ||
        terminal?.lifecycle !== RunEvidenceLifecycle.Failed
      )
        lifecycleIssue(
          context,
          "failed evidence does not end at iteration breakage"
        )
      return
    case RunEvidenceLifecycle.Incomplete:
      if (
        last?.accountCount !== manifest.rampConfig.maxCount ||
        missing.length === 0 ||
        terminal?.lifecycle !== RunEvidenceLifecycle.Incomplete
      )
        lifecycleIssue(
          context,
          "incomplete evidence is not exact-max with missing endpoints"
        )
      return
    case RunEvidenceLifecycle.Saturated:
      if (
        missing.length !== 0 ||
        terminal?.lifecycle !== RunEvidenceLifecycle.Saturated ||
        last?.outcome === RunEvidenceIterationOutcome.Breakage
      )
        lifecycleIssue(
          context,
          "saturated evidence lacks all-endpoint completed phases"
        )
      return
    default:
      return assertNever(manifest)
  }
}

function lifecycleIssue(
  context: RunEvidenceVerificationContext,
  detail: string
): void {
  context.issue(
    RunEvidenceVerificationIssueCode.LifecycleMismatch,
    "$run",
    detail
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

function assertNever(value: never): never {
  throw new Error(`Unexpected evidence lifecycle: ${String(value)}`)
}
