import { createHash } from "node:crypto"

import {
  parseRunEvidenceArtifact,
  parseRunEvidenceIteration,
  parseRunEvidenceManifest,
  parseRunEvidenceProvenance,
  parseRunEvidenceSetup,
  parseRunEvidenceTerminal,
  RunEvidenceClusterConfigState,
  RunEvidenceLifecycle,
  RunEvidencePath,
  RunEvidenceSetupStatus,
  type RunEvidenceIteration,
  type RunEvidenceManifest,
  type RunEvidenceParseResult,
  type RunEvidenceSetup,
  type RunEvidenceTerminal
} from "../runEvidenceTypes.js"
import { canonicalEvidenceJson } from "../run-evidence/canonicalEvidenceJson.js"
import { RunEvidenceVerificationIssueCode } from "../runEvidenceVerifierTypes.js"
import { readPinnedFile } from "./pinnedFileReader.js"
import type { PinnedRunDirectory } from "./pinnedPathSupport.js"
import { verifyEvidenceRecordAgreement } from "./evidenceRecordAgreement.js"
import { RunEvidenceVerificationContext } from "./verifierIssues.js"

/** Parsed schema-v1 records loaded from exact canonical bytes. */
export type LoadedRunEvidence = {
  readonly manifest: RunEvidenceManifest
  readonly setup: RunEvidenceSetup | null
  readonly iterations: readonly RunEvidenceIteration[]
  readonly terminal: RunEvidenceTerminal | null
}

/** Load and structurally parse the canonical manifest. */
export function loadRunEvidenceManifest(
  root: PinnedRunDirectory,
  context: RunEvidenceVerificationContext
): RunEvidenceManifest | null {
  const loaded = readCanonicalRecord(
    root,
    RunEvidencePath.Manifest,
    parseRunEvidenceManifest,
    RunEvidenceVerificationIssueCode.InvalidManifest,
    context
  )
  if (loaded === null) return null
  const provenance = parseRunEvidenceProvenance(loaded.value.provenance)
  if ("error" in provenance)
    context.issue(
      RunEvidenceVerificationIssueCode.InvalidProvenance,
      RunEvidencePath.Manifest,
      `provenance parser rejected ${provenance.error.code}`
    )
  loaded.value.artifacts.forEach((artifact, index) => {
    const parsed = parseRunEvidenceArtifact(artifact)
    if ("error" in parsed)
      context.issue(
        RunEvidenceVerificationIssueCode.InvalidArtifact,
        RunEvidencePath.Manifest,
        `artifact ${index} parser rejected ${parsed.error.code}`
      )
  })
  return loaded.value
}

/** Load every manifest-declared lifecycle record and exact digest target. */
export function loadDeclaredRunEvidence(
  root: PinnedRunDirectory,
  manifest: RunEvidenceManifest,
  context: RunEvidenceVerificationContext
): LoadedRunEvidence {
  if (manifest.lifecycle === RunEvidenceLifecycle.Initializing)
    return { manifest, setup: null, iterations: [], terminal: null }
  const setup = readReferencedRecord(
    root,
    manifest.records.setup,
    parseRunEvidenceSetup,
    RunEvidenceVerificationIssueCode.InvalidSetup,
    context
  )
  const iterations = manifest.records.iterations.flatMap(ref => {
    const loaded = readReferencedRecord(
      root,
      ref,
      parseRunEvidenceIteration,
      RunEvidenceVerificationIssueCode.InvalidIteration,
      context
    )
    return loaded === null ? [] : [loaded]
  })
  const terminal =
    manifest.records.terminal === null
      ? null
      : readReferencedRecord(
          root,
          manifest.records.terminal,
          parseRunEvidenceTerminal,
          RunEvidenceVerificationIssueCode.InvalidTerminal,
          context
        )
  verifyConfigSnapshot(root, manifest, context)
  verifyEvidenceRecordAgreement(manifest, setup, iterations, terminal, context)
  return { manifest, setup, iterations, terminal }
}

type RecordRef = { readonly path: string; readonly sha256: string }

function readReferencedRecord<T>(
  root: PinnedRunDirectory,
  ref: RecordRef,
  parser: (value: unknown) => RunEvidenceParseResult<T>,
  issueCode: RunEvidenceVerificationIssueCode,
  context: RunEvidenceVerificationContext
): T | null {
  const loaded = readCanonicalRecord(root, ref.path, parser, issueCode, context)
  if (loaded !== null && sha256(loaded.bytes) !== ref.sha256)
    context.issue(
      RunEvidenceVerificationIssueCode.HashMismatch,
      ref.path,
      `record digest differs from manifest ref ${ref.sha256}`
    )
  return loaded?.value ?? null
}

function readCanonicalRecord<T>(
  root: PinnedRunDirectory,
  path: string,
  parser: (value: unknown) => RunEvidenceParseResult<T>,
  issueCode: RunEvidenceVerificationIssueCode,
  context: RunEvidenceVerificationContext
): { readonly value: T; readonly bytes: Buffer } | null {
  const bytes = readPinnedFile(root, path, context)
  if (bytes === null) return null
  let input: unknown
  try {
    input = JSON.parse(bytes.toString("utf8"))
  } catch (error) {
    context.issue(
      RunEvidenceVerificationIssueCode.InvalidJson,
      path,
      error instanceof Error ? error.message : String(error)
    )
    return null
  }
  const parsed = parser(input)
  if ("error" in parsed) {
    context.issue(
      issueCode,
      path,
      `schema parser rejected ${parsed.error.code}`
    )
    return null
  }
  if (!canonicalEvidenceJson(parsed.value).equals(bytes))
    context.issue(
      RunEvidenceVerificationIssueCode.NonCanonicalJson,
      path,
      "record bytes differ from the canonical serializer"
    )
  return { value: parsed.value, bytes }
}

function verifyConfigSnapshot(
  root: PinnedRunDirectory,
  manifest: RunEvidenceManifest,
  context: RunEvidenceVerificationContext
): void {
  if (
    manifest.clusterConfigSnapshot.kind !==
    RunEvidenceClusterConfigState.Captured
  )
    return
  const snapshot = manifest.clusterConfigSnapshot,
    bytes = readPinnedFile(root, snapshot.path, context)
  if (bytes !== null && sha256(bytes) !== snapshot.sha256)
    context.issue(
      RunEvidenceVerificationIssueCode.HashMismatch,
      snapshot.path,
      `config digest differs from manifest ref ${snapshot.sha256}`
    )
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}
