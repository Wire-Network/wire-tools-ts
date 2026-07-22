import * as Path from "node:path"

import {
  EnvelopeIntegrityIssueCode,
  type EnvelopeBaseline,
  type EnvelopeBaselineCaptureResult,
  type EnvelopeIntegrityDependencies,
  type EnvelopeIntegrityFileError,
  type EnvelopeIntegrityFileSystem,
  type EnvelopeIntegrityIssue,
  type EnvelopeIntegrityIssueSequence,
  type EnvelopeIntegrityResult
} from "./EnvelopeIntegrityReaderTypes.js"
import { createEnvelopeBaseline } from "./envelopeBaseline.js"
import { NodeEnvelopeIntegrityFileSystem } from "./envelopeIntegrityFileSystem.js"
import { rootChangedIssue } from "./envelopeIntegrityIssues.js"
import {
  baselineFailure,
  closeEnvelopeReaderIssues,
  nonEmptyIssues,
  prependIssues,
  rootFailure
} from "./envelopeIntegrityReaderFailure.js"
import {
  pinEnvelopeStorageRoot,
  type PinnedEnvelopeStorageRoot
} from "./envelopeIntegrityRoot.js"
import { verifyEnvelopeStorageRoot } from "./envelopeIntegrityRootVerification.js"
import {
  compareCodeUnits,
  scanEnvelopeSidecars
} from "./envelopeIntegritySidecarScan.js"
import { revalidateEnvelopeSidecarSnapshot } from "./envelopeIntegritySnapshot.js"
import { validateEnvelopeCandidate } from "./envelopeIntegrityValidation.js"
import { validateWithWorkerPool } from "./envelopeIntegrityWorkerPool.js"

export * from "./EnvelopeIntegrityReaderTypes.js"
export { createEnvelopeBaseline } from "./envelopeBaseline.js"

const StorageScopeBaseKey = "$storage"

/**
 * Capture every canonical or invalid base key visible through either sidecar suffix.
 *
 * @param storageDir OPP debugging storage directory.
 * @param dependencies Optional no-follow filesystem seam.
 * @returns A sorted all-key baseline or a normalized capture issue.
 */
export async function captureEnvelopeBaseline(
  storageDir: string,
  dependencies: EnvelopeIntegrityDependencies = {}
): Promise<EnvelopeBaselineCaptureResult> {
  const storageRoot = Path.resolve(storageDir),
    fileSystem = dependencies.fileSystem ?? NodeEnvelopeIntegrityFileSystem,
    pinned = await pinEnvelopeStorageRoot(storageRoot, fileSystem)
  if (pinned.kind === "issue") return baselineFailure(pinned.issues)
  const scan = await scanEnvelopeSidecars(pinned.root.handle)
  if (scan.kind === "failed") {
    return baselineFailure(
      await closeEnvelopeReaderIssues(
        pinned.root,
        [],
        [baselineScanIssue(storageRoot, scan.error)]
      )
    )
  }
  const postScanIssues = await verifyEnvelopeStorageRoot(
    pinned.root,
    fileSystem
  )
  if (postScanIssues !== null) {
    return baselineFailure(
      await closeEnvelopeReaderIssues(pinned.root, [], postScanIssues)
    )
  }
  const snapshot = await revalidateEnvelopeSidecarSnapshot(
    pinned.root.handle,
    scan.snapshot
  )
  if (snapshot.kind === "failed") {
    return baselineFailure(
      await closeEnvelopeReaderIssues(
        pinned.root,
        [],
        [baselineScanIssue(storageRoot, snapshot.error)]
      )
    )
  }
  if (snapshot.kind === "changed") {
    return baselineFailure(
      await closeEnvelopeReaderIssues(
        pinned.root,
        [],
        [snapshotChangedIssue(pinned.root)]
      )
    )
  }
  const finalIssues = await verifyEnvelopeStorageRoot(pinned.root, fileSystem),
    closedIssues = await closeEnvelopeReaderIssues(
      pinned.root,
      [],
      finalIssues ?? []
    ),
    failureIssues = nonEmptyIssues(closedIssues)
  return failureIssues === null
    ? { kind: "captured", baseline: createEnvelopeBaseline(scan.baseKeys) }
    : baselineFailure(failureIssues)
}

/**
 * Discover post-baseline envelope pairs and validate them with sixteen workers.
 * Candidate failures are returned as structured issues and never thrown.
 *
 * @param storageDir OPP debugging storage directory.
 * @param baseline All-key baseline captured before the observed phase.
 * @param dependencies Optional no-follow filesystem seam.
 * @returns Deterministically sorted valid, pending, and issue records.
 */
export async function readEnvelopeIntegrity(
  storageDir: string,
  baseline: EnvelopeBaseline,
  dependencies: EnvelopeIntegrityDependencies = {}
): Promise<EnvelopeIntegrityResult> {
  const storageRoot = Path.resolve(storageDir),
    fileSystem = dependencies.fileSystem ?? NodeEnvelopeIntegrityFileSystem,
    pinned = await pinEnvelopeStorageRoot(storageRoot, fileSystem)
  if (pinned.kind === "issue") return rootFailure(pinned.issues)
  const scan = await scanEnvelopeSidecars(pinned.root.handle)
  if (scan.kind === "failed") {
    return closeReadFailure(pinned.root, [
      directoryScanIssue(storageRoot, scan.error)
    ])
  }
  const postScanIssues = await verifyEnvelopeStorageRoot(
    pinned.root,
    fileSystem
  )
  if (postScanIssues !== null) {
    return closeReadFailure(pinned.root, postScanIssues, scan.baseKeys)
  }
  const postScanSnapshot = await revalidateEnvelopeSidecarSnapshot(
    pinned.root.handle,
    scan.snapshot
  )
  if (postScanSnapshot.kind === "failed") {
    return closeReadFailure(
      pinned.root,
      [directoryScanIssue(storageRoot, postScanSnapshot.error)],
      scan.baseKeys
    )
  }
  if (postScanSnapshot.kind === "changed") {
    return closeReadFailure(
      pinned.root,
      [snapshotChangedIssue(pinned.root)],
      scan.baseKeys
    )
  }

  const baselineKeys = new Set(baseline.baseKeys),
    candidates = scan.baseKeys.filter(baseKey => !baselineKeys.has(baseKey)),
    results = await validateWithWorkerPool(candidates, baseKey =>
      validateEnvelopeCandidate({
        root: pinned.root,
        baseKey,
        filenames: scan.filenames
      })
    ),
    ordered = [...results].sort((left, right) =>
      compareCodeUnits(resultBaseKey(left), resultBaseKey(right))
    ),
    valid = ordered.flatMap(result =>
      result.kind === "valid" ? [result.value] : []
    ),
    pending = ordered.flatMap(result =>
      result.kind === "pending" ? [result.value] : []
    ),
    issues = ordered.flatMap(result =>
      result.kind === "valid" ? [] : [result.issue]
    )
  const finalSnapshot = await revalidateEnvelopeSidecarSnapshot(
    pinned.root.handle,
    scan.snapshot
  )
  if (finalSnapshot.kind === "failed") {
    return closeReadFailure(
      pinned.root,
      [directoryScanIssue(storageRoot, finalSnapshot.error)],
      candidates,
      issues
    )
  }
  if (finalSnapshot.kind === "changed") {
    return closeReadFailure(
      pinned.root,
      [snapshotChangedIssue(pinned.root)],
      candidates,
      issues
    )
  }
  const finalRootIssues = await verifyEnvelopeStorageRoot(
      pinned.root,
      fileSystem
    ),
    terminalIssues = nonEmptyIssues(
      await closeEnvelopeReaderIssues(pinned.root, [], finalRootIssues ?? [])
    )
  if (terminalIssues !== null) {
    return rootFailure(prependIssues(issues, terminalIssues), candidates)
  }
  return {
    kind: "collected",
    candidates,
    valid,
    pending,
    issues
  }
}

async function closeReadFailure(
  root: PinnedEnvelopeStorageRoot,
  initiatingIssues: EnvelopeIntegrityIssueSequence,
  candidates: readonly string[] = [],
  candidateIssues: readonly EnvelopeIntegrityIssue[] = []
): Promise<EnvelopeIntegrityResult> {
  return rootFailure(
    await closeEnvelopeReaderIssues(root, candidateIssues, initiatingIssues),
    candidates
  )
}

function snapshotChangedIssue(
  root: PinnedEnvelopeStorageRoot
): EnvelopeIntegrityIssue {
  const [issue] = rootChangedIssue(root.path, root.identity, null, null).issues
  return issue
}

function baselineScanIssue(
  storageRoot: string,
  error: EnvelopeIntegrityFileError
): EnvelopeIntegrityIssue {
  return {
    code: EnvelopeIntegrityIssueCode.BaselineCaptureFailed,
    baseKey: StorageScopeBaseKey,
    context: { storageDir: storageRoot, error }
  }
}

function directoryScanIssue(
  storageRoot: string,
  error: EnvelopeIntegrityFileError
): EnvelopeIntegrityIssue {
  return {
    code: EnvelopeIntegrityIssueCode.DirectoryScanFailed,
    baseKey: StorageScopeBaseKey,
    context: { storageDir: storageRoot, error }
  }
}

function resultBaseKey(
  result: Awaited<ReturnType<typeof validateEnvelopeCandidate>>
): string {
  return result.kind === "valid" ? result.value.baseKey : result.issue.baseKey
}
