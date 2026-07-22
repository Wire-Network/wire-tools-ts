import * as Path from "node:path"

import {
  RunEvidenceClusterConfigState,
  RunEvidenceLifecycle,
  RunEvidencePath,
  type RunEvidenceManifest
} from "../runEvidenceTypes.js"
import { RunEvidenceVerificationIssueCode } from "../runEvidenceVerifierTypes.js"
import {
  enumeratePinnedDirectory,
  lstatPinnedEntry
} from "./pinnedDirectoryEntries.js"
import { pinNestedDirectory } from "./pinnedDirectoryDescriptors.js"
import type { PinnedRunDirectory } from "./pinnedPathSupport.js"
import { RunEvidenceVerificationContext } from "./verifierIssues.js"

/** Verify that the clean schema-v1 tree contains exactly declared entries. */
export function verifyEvidenceTopology(
  root: PinnedRunDirectory,
  manifest: RunEvidenceManifest,
  context: RunEvidenceVerificationContext
): void {
  const expectedRoot = new Set([
      RunEvidencePath.Manifest,
      RunEvidencePath.Iterations,
      "artifacts"
    ]),
    expectedIterations = new Set(
      manifest.records.iterations.map(ref => Path.posix.basename(ref.path))
    ),
    expectedArtifacts = new Set(
      manifest.artifacts.flatMap(entry => [
        Path.posix.basename(entry.firstImmutableRefs.data.path),
        Path.posix.basename(entry.firstImmutableRefs.metadata.path)
      ])
    )
  if (manifest.lifecycle !== RunEvidenceLifecycle.Initializing)
    expectedRoot.add(RunEvidencePath.Setup)
  if (manifest.records.terminal !== null)
    expectedRoot.add(RunEvidencePath.Terminal)
  if (
    manifest.clusterConfigSnapshot.kind ===
    RunEvidenceClusterConfigState.Captured
  )
    expectedRoot.add(RunEvidencePath.ClusterConfigSnapshot)
  verifyDirectoryEntries(root, "", expectedRoot, context)
  pinNestedDirectory(root, RunEvidencePath.Iterations, context)
  pinNestedDirectory(root, "artifacts", context)
  pinNestedDirectory(root, RunEvidencePath.Artifacts, context)
  verifyDirectoryEntries(
    root,
    RunEvidencePath.Iterations,
    expectedIterations,
    context
  )
  verifyDirectoryEntries(root, "artifacts", new Set(["opp"]), context)
  verifyDirectoryEntries(
    root,
    RunEvidencePath.Artifacts,
    expectedArtifacts,
    context
  )
}

function verifyDirectoryEntries(
  root: PinnedRunDirectory,
  relativeDirectory: string,
  expectedNames: ReadonlySet<string>,
  context: RunEvidenceVerificationContext
): void {
  const actualNames = enumeratePinnedDirectory(root, relativeDirectory, context)
  expectedNames.forEach(name => {
    if (!actualNames.includes(name))
      context.issue(
        RunEvidenceVerificationIssueCode.MissingEntry,
        joinPortable(relativeDirectory, name),
        "declared schema-v1 entry is missing"
      )
  })
  actualNames.forEach(name => {
    const relativePath = joinPortable(relativeDirectory, name),
      stat = lstatPinnedEntry(root, relativePath, context)
    if (stat === null) return
    if (stat.isSymbolicLink())
      context.issue(
        RunEvidenceVerificationIssueCode.SymlinkEntry,
        relativePath,
        "enumerated entry is a symbolic link"
      )
    else if (!expectedNames.has(name))
      context.issue(
        stat.isDirectory()
          ? RunEvidenceVerificationIssueCode.UnexpectedDirectory
          : stat.isFile()
            ? RunEvidenceVerificationIssueCode.ExtraEntry
            : RunEvidenceVerificationIssueCode.NonRegularEntry,
        relativePath,
        "entry is not declared by the schema-v1 manifest"
      )
    else if (!expectedDirectory(relativePath) && !stat.isFile())
      context.issue(
        RunEvidenceVerificationIssueCode.NonRegularEntry,
        relativePath,
        "declared file is not regular"
      )
    else if (expectedDirectory(relativePath) && !stat.isDirectory())
      context.issue(
        RunEvidenceVerificationIssueCode.UnexpectedDirectory,
        relativePath,
        "declared directory is not a directory"
      )
  })
}

function expectedDirectory(path: string): boolean {
  return (
    path === RunEvidencePath.Iterations ||
    path === "artifacts" ||
    path === RunEvidencePath.Artifacts
  )
}

function joinPortable(directory: string, name: string): string {
  return directory.length === 0 ? name : `${directory}/${name}`
}
