import * as Fs from "node:fs"

import { RunEvidenceVerificationIssueCode } from "../runEvidenceVerifierTypes.js"
import { verifyPinnedDirectory } from "./pinnedDirectoryDescriptors.js"
import {
  containedRunPath,
  descriptorEntryPath,
  pinnedEntry,
  type PinnedRunDirectory,
  sameVerifierIdentity,
  verifierErrorText,
  verifierIdentity
} from "./pinnedPathSupport.js"
import { RunEvidenceVerificationContext } from "./verifierIssues.js"

type PinnedEvidenceFile = {
  readonly anchoredPath: string
  readonly relativePath: string
  readonly before: Fs.BigIntStats
}

/** Read one contained regular file relative to a held no-follow parent descriptor. */
export function readPinnedFile(
  root: PinnedRunDirectory,
  relativePath: string,
  context: RunEvidenceVerificationContext
): Buffer | null {
  const entry = pinnedEntry(root, relativePath, context)
  if (
    entry === null ||
    containedRunPath(root, relativePath, context) === null ||
    !verifyPinnedDirectory(root, entry.parent, context)
  )
    return null
  const anchoredPath = descriptorEntryPath(entry.parent, entry.basename)
  let before: Fs.BigIntStats
  try {
    before = Fs.lstatSync(anchoredPath, { bigint: true })
  } catch (error) {
    context.issue(
      RunEvidenceVerificationIssueCode.MissingEntry,
      relativePath,
      `file cannot be inspected: ${verifierErrorText(error)}`
    )
    return null
  }
  if (!isRegularEvidenceFile(before, relativePath, context)) return null
  return descriptorRead(
    root,
    {
      anchoredPath,
      relativePath,
      before
    },
    context
  )
}

function descriptorRead(
  root: PinnedRunDirectory,
  file: PinnedEvidenceFile,
  context: RunEvidenceVerificationContext
): Buffer | null {
  const { anchoredPath, relativePath, before } = file
  let descriptor: number | null = null
  try {
    descriptor = Fs.openSync(
      anchoredPath,
      Fs.constants.O_RDONLY | Fs.constants.O_NOFOLLOW
    )
    const openedBefore = Fs.fstatSync(descriptor, { bigint: true })
    if (
      !sameVerifierIdentity(
        verifierIdentity(before),
        verifierIdentity(openedBefore)
      )
    ) {
      changed(relativePath, context, "file changed while opening")
      return null
    }
    const bytes = Fs.readFileSync(descriptor)
    const openedAfter = Fs.fstatSync(descriptor, { bigint: true }),
      current = Fs.lstatSync(anchoredPath, { bigint: true }),
      entry = pinnedEntry(root, relativePath, context)
    if (
      entry === null ||
      !sameVerifierIdentity(
        verifierIdentity(openedBefore),
        verifierIdentity(openedAfter)
      ) ||
      !sameVerifierIdentity(
        verifierIdentity(openedAfter),
        verifierIdentity(current)
      ) ||
      !verifyPinnedDirectory(root, entry.parent, context)
    ) {
      changed(
        relativePath,
        context,
        "file or parent directory changed during read"
      )
      return null
    }
    context.checkedFile(relativePath)
    return bytes
  } catch (error) {
    context.issue(
      RunEvidenceVerificationIssueCode.ReadFailed,
      relativePath,
      `descriptor read failed: ${verifierErrorText(error)}`
    )
    return null
  } finally {
    closeDescriptor(descriptor, relativePath, context)
  }
}

function isRegularEvidenceFile(
  stat: Fs.BigIntStats,
  relativePath: string,
  context: RunEvidenceVerificationContext
): boolean {
  if (stat.isSymbolicLink()) {
    context.issue(
      RunEvidenceVerificationIssueCode.SymlinkEntry,
      relativePath,
      "file reference is a symbolic link"
    )
    return false
  }
  if (stat.isFile()) return true
  context.issue(
    RunEvidenceVerificationIssueCode.NonRegularEntry,
    relativePath,
    "file reference is not a regular file"
  )
  return false
}

function closeDescriptor(
  descriptor: number | null,
  relativePath: string,
  context: RunEvidenceVerificationContext
): void {
  if (descriptor === null) return
  try {
    Fs.closeSync(descriptor)
  } catch (error) {
    context.issue(
      RunEvidenceVerificationIssueCode.ReadFailed,
      relativePath,
      `descriptor close failed: ${verifierErrorText(error)}`
    )
  }
}

function changed(
  path: string,
  context: RunEvidenceVerificationContext,
  detail: string
): void {
  context.issue(RunEvidenceVerificationIssueCode.FileChanged, path, detail)
}
