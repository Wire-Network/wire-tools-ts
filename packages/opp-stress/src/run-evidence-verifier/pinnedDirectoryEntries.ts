import * as Fs from "node:fs"

import { RunEvidenceVerificationIssueCode } from "../runEvidenceVerifierTypes.js"
import { verifyPinnedDirectory } from "./pinnedDirectoryDescriptors.js"
import {
  descriptorEntryPath,
  pinnedEntry,
  type PinnedRunDirectory,
  verifierErrorText
} from "./pinnedPathSupport.js"
import { RunEvidenceVerificationContext } from "./verifierIssues.js"

/** Enumerate one held expected directory without trusting Dirent file types. */
export function enumeratePinnedDirectory(
  root: PinnedRunDirectory,
  relativeDirectory: string,
  context: RunEvidenceVerificationContext
): readonly string[] {
  const directory = root.directories.get(relativeDirectory)
  if (
    directory === undefined ||
    !verifyPinnedDirectory(root, directory, context)
  )
    return []
  try {
    const names = Fs.readdirSync(descriptorEntryPath(directory)).sort()
    return verifyPinnedDirectory(root, directory, context) ? names : []
  } catch (error) {
    context.issue(
      RunEvidenceVerificationIssueCode.ReadFailed,
      relativeDirectory || "$run",
      `directory enumeration failed: ${verifierErrorText(error)}`
    )
    return []
  }
}

/** Inspect one contained topology entry relative to its held parent descriptor. */
export function lstatPinnedEntry(
  root: PinnedRunDirectory,
  relativePath: string,
  context: RunEvidenceVerificationContext
): Fs.BigIntStats | null {
  const entry = pinnedEntry(root, relativePath, context)
  if (entry === null || !verifyPinnedDirectory(root, entry.parent, context))
    return null
  try {
    return Fs.lstatSync(descriptorEntryPath(entry.parent, entry.basename), {
      bigint: true
    })
  } catch (error) {
    context.issue(
      RunEvidenceVerificationIssueCode.MissingEntry,
      relativePath,
      `entry cannot be inspected: ${verifierErrorText(error)}`
    )
    return null
  }
}
