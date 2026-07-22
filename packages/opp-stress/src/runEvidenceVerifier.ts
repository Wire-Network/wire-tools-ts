import { RunEvidenceLifecycle } from "./runEvidenceTypes.js"
import {
  RunEvidenceVerificationVerdict,
  type RunEvidenceVerificationReport
} from "./runEvidenceVerifierTypes.js"
import { verifyEvidenceArtifacts } from "./run-evidence-verifier/evidenceArtifacts.js"
import { recomputeEvidenceCampaign } from "./run-evidence-verifier/evidenceCampaign.js"
import { closePinnedRunDirectory } from "./run-evidence-verifier/pinnedDirectoryDescriptors.js"
import {
  loadDeclaredRunEvidence,
  loadRunEvidenceManifest
} from "./run-evidence-verifier/evidenceRecords.js"
import { verifyEvidenceTopology } from "./run-evidence-verifier/evidenceTopology.js"
import { pinRunDirectory } from "./run-evidence-verifier/pinnedRunDirectory.js"
import { RunEvidenceVerificationContext } from "./run-evidence-verifier/verifierIssues.js"

export * from "./runEvidenceVerifierTypes.js"

const EvidenceLimitations = [
  "lastAcceptedBatchOpNames and later observation ordinals are structurally checked publisher claims because only first immutable metadata bytes are persisted",
  "historical candidate completeness, filtered valid candidates, and telemetry issue occurrence are unauthenticated publisher snapshot claims because only selected valid immutable pairs are retained and the manifest has no external trust root"
] as const

/**
 * Independently verify one explicit schema-v1 evidence run without network or
 * mutable cluster/provenance reads.
 *
 * @param runDirectory Absolute normalized path of the run directory to verify.
 * @returns JSON-safe report with deterministic issues and recomputed results.
 */
export function verifyRunEvidence(
  runDirectory: string
): RunEvidenceVerificationReport {
  const context = new RunEvidenceVerificationContext(),
    root = pinRunDirectory(runDirectory, context)
  if (root === null) return emptyReport(runDirectory, context)
  let verified: {
    readonly manifest: NonNullable<ReturnType<typeof loadRunEvidenceManifest>>
    readonly recomputed: ReturnType<typeof recomputeEvidenceCampaign>
    readonly publisherClaims: ReturnType<
      typeof verifyEvidenceArtifacts
    >["publisherClaims"]
  } | null = null
  try {
    const manifest = loadRunEvidenceManifest(root, context)
    if (manifest !== null) {
      verifyEvidenceTopology(root, manifest, context)
      const loaded = loadDeclaredRunEvidence(root, manifest, context),
        artifacts = verifyEvidenceArtifacts(root, manifest, context),
        recomputed = recomputeEvidenceCampaign(
          manifest,
          loaded.setup,
          loaded.iterations,
          loaded.terminal,
          artifacts,
          context
        )
      verified = {
        manifest,
        recomputed,
        publisherClaims: artifacts.publisherClaims
      }
    }
  } finally {
    closePinnedRunDirectory(root, context)
  }
  if (verified === null) return emptyReport(runDirectory, context)
  const { manifest, recomputed, publisherClaims } = verified,
    issues = context.issues(),
    valid = issues.length === 0,
    verdict = valid
      ? verdictFor(manifest.lifecycle)
      : RunEvidenceVerificationVerdict.Invalid
  return {
    schemaVersion: 1,
    runDirectory,
    valid,
    verdict,
    lifecycle: manifest.lifecycle,
    verifiedSaturated:
      valid && manifest.lifecycle === RunEvidenceLifecycle.Saturated,
    issues,
    checkedFiles: context.checkedFiles(),
    recomputedEndpoints: recomputed.endpoints,
    recomputedIterations: recomputed.iterations,
    publisherClaims,
    limitations: EvidenceLimitations
  }
}

function emptyReport(
  runDirectory: string,
  context: RunEvidenceVerificationContext
): RunEvidenceVerificationReport {
  return {
    schemaVersion: 1,
    runDirectory,
    valid: false,
    verdict: RunEvidenceVerificationVerdict.Invalid,
    lifecycle: null,
    verifiedSaturated: false,
    issues: context.issues(),
    checkedFiles: context.checkedFiles(),
    recomputedEndpoints: [],
    recomputedIterations: [],
    publisherClaims: [],
    limitations: EvidenceLimitations
  }
}

function verdictFor(
  lifecycle: RunEvidenceLifecycle
): RunEvidenceVerificationVerdict {
  switch (lifecycle) {
    case RunEvidenceLifecycle.Initializing:
    case RunEvidenceLifecycle.Running:
      return RunEvidenceVerificationVerdict.InProgress
    case RunEvidenceLifecycle.SetupFailed:
    case RunEvidenceLifecycle.Failed:
    case RunEvidenceLifecycle.Incomplete:
      return RunEvidenceVerificationVerdict.NonSuccess
    case RunEvidenceLifecycle.Saturated:
      return RunEvidenceVerificationVerdict.Saturated
    default:
      return assertNever(lifecycle)
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected verified lifecycle: ${String(value)}`)
}
