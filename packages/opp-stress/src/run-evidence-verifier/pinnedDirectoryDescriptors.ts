import * as Fs from "node:fs"
import * as Path from "node:path"

import { RunEvidenceVerificationIssueCode } from "../runEvidenceVerifierTypes.js"
import {
  descriptorEntryPath,
  type PinnedDirectory,
  type PinnedRunDirectory,
  sameVerifierIdentity,
  verifierErrorText,
  verifierIdentity
} from "./pinnedPathSupport.js"
import { RunEvidenceVerificationContext } from "./verifierIssues.js"

const DirectoryOpenFlags =
  Fs.constants.O_RDONLY | Fs.constants.O_DIRECTORY | Fs.constants.O_NOFOLLOW

/** Open and retain one expected child directory relative to its held parent. */
export function pinNestedDirectory(
  root: PinnedRunDirectory,
  relativePath: string,
  context: RunEvidenceVerificationContext
): PinnedDirectory | null {
  const parentPath = Path.posix.dirname(relativePath),
    parent = root.directories.get(parentPath === "." ? "" : parentPath),
    basename = Path.posix.basename(relativePath)
  if (parent === undefined || !verifyPinnedDirectory(root, parent, context)) {
    context.issue(
      RunEvidenceVerificationIssueCode.ReadFailed,
      relativePath,
      "directory parent is unavailable"
    )
    return null
  }
  const entryPath = descriptorEntryPath(parent, basename)
  let descriptor: number | null = null
  try {
    const before = Fs.lstatSync(entryPath, { bigint: true })
    if (before.isSymbolicLink() || !before.isDirectory()) {
      directoryTypeIssue(relativePath, before.isSymbolicLink(), context)
      return null
    }
    descriptor = Fs.openSync(entryPath, DirectoryOpenFlags)
    const opened = Fs.fstatSync(descriptor, { bigint: true }),
      current = Fs.lstatSync(entryPath, { bigint: true })
    if (
      !sameVerifierIdentity(
        verifierIdentity(before),
        verifierIdentity(opened)
      ) ||
      !sameVerifierIdentity(verifierIdentity(opened), verifierIdentity(current))
    ) {
      changed(relativePath, context, "directory changed while opening")
      return null
    }
    const directory: PinnedDirectory = {
      relativePath,
      descriptor,
      identity: verifierIdentity(opened),
      parent,
      basename
    }
    descriptor = null
    root.directories.set(relativePath, directory)
    root.openedDirectories.push(directory)
    return directory
  } catch (error) {
    context.issue(
      RunEvidenceVerificationIssueCode.ReadFailed,
      relativePath,
      `directory pin failed: ${verifierErrorText(error)}`
    )
    return null
  } finally {
    if (descriptor !== null) closeOne(descriptor, relativePath, context)
  }
}

/** Revalidate a held descriptor and its current anchored directory entry. */
export function verifyPinnedDirectory(
  root: PinnedRunDirectory,
  directory: PinnedDirectory,
  context: RunEvidenceVerificationContext
): boolean {
  if (
    directory.parent !== null &&
    !verifyPinnedDirectory(root, directory.parent, context)
  )
    return false
  try {
    const opened = Fs.fstatSync(directory.descriptor, { bigint: true }),
      current = Fs.lstatSync(currentDirectoryPath(root, directory), {
        bigint: true
      })
    if (current.isSymbolicLink()) {
      context.issue(
        RunEvidenceVerificationIssueCode.SymlinkEntry,
        directory.relativePath || "$run",
        "pinned directory entry became a symbolic link"
      )
      return false
    }
    if (
      !current.isDirectory() ||
      !sameVerifierIdentity(directory.identity, verifierIdentity(opened)) ||
      !sameVerifierIdentity(directory.identity, verifierIdentity(current))
    ) {
      changed(
        directory.relativePath || "$run",
        context,
        "pinned directory identity changed"
      )
      return false
    }
    return directory.parent !== null || verifyExplicitRoot(root, context)
  } catch (error) {
    changed(
      directory.relativePath || "$run",
      context,
      `pinned directory cannot be revalidated: ${verifierErrorText(error)}`
    )
    return false
  }
}

/** Close every retained directory descriptor in reverse open order. */
export function closePinnedRunDirectory(
  root: PinnedRunDirectory,
  context: RunEvidenceVerificationContext
): void {
  const directories = [...root.openedDirectories].reverse()
  directories.forEach(directory =>
    closeOne(directory.descriptor, directory.relativePath || "$run", context)
  )
}

function verifyExplicitRoot(
  root: PinnedRunDirectory,
  context: RunEvidenceVerificationContext
): boolean {
  if (Fs.realpathSync.native(root.path) === root.path) return true
  context.issue(
    RunEvidenceVerificationIssueCode.NonCanonicalRoot,
    "$run",
    "run directory realpath changed during verification"
  )
  return false
}

function currentDirectoryPath(
  root: PinnedRunDirectory,
  directory: PinnedDirectory
): string {
  return directory.parent === null || directory.basename === null
    ? root.path
    : descriptorEntryPath(directory.parent, directory.basename)
}

function directoryTypeIssue(
  relativePath: string,
  symbolicLink: boolean,
  context: RunEvidenceVerificationContext
): void {
  context.issue(
    symbolicLink
      ? RunEvidenceVerificationIssueCode.SymlinkEntry
      : RunEvidenceVerificationIssueCode.UnexpectedDirectory,
    relativePath,
    "expected directory is not a regular directory"
  )
}

function changed(
  path: string,
  context: RunEvidenceVerificationContext,
  detail: string
): void {
  context.issue(
    path === "$run"
      ? RunEvidenceVerificationIssueCode.RootChanged
      : RunEvidenceVerificationIssueCode.FileChanged,
    path,
    detail
  )
}

function closeOne(
  descriptor: number,
  path: string,
  context: RunEvidenceVerificationContext
): void {
  try {
    Fs.closeSync(descriptor)
  } catch (error) {
    context.issue(
      RunEvidenceVerificationIssueCode.ReadFailed,
      path,
      `directory descriptor close failed: ${verifierErrorText(error)}`
    )
  }
}
