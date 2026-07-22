import * as Fs from "node:fs"
import * as Path from "node:path"

import {
  RunEvidenceVerificationIssueCode,
  RunEvidenceVerifierInvocationError
} from "../runEvidenceVerifierTypes.js"
import {
  type PinnedDirectory,
  type PinnedRunDirectory,
  sameVerifierIdentity,
  verifierErrorText,
  verifierIdentity
} from "./pinnedPathSupport.js"
import { RunEvidenceVerificationContext } from "./verifierIssues.js"

const DirectoryOpenFlags =
  Fs.constants.O_RDONLY | Fs.constants.O_DIRECTORY | Fs.constants.O_NOFOLLOW

/** Validate and retain a no-follow descriptor for an explicit run directory. */
export function pinRunDirectory(
  runDirectory: string,
  context: RunEvidenceVerificationContext
): PinnedRunDirectory | null {
  if (
    !Path.isAbsolute(runDirectory) ||
    Path.resolve(runDirectory) !== runDirectory
  )
    throw new RunEvidenceVerifierInvocationError(
      runDirectory,
      "run directory must be an absolute normalized path"
    )
  const before = inspectExplicitRoot(runDirectory, context)
  if (before === null) return null
  inspectRunComponents(runDirectory, context)
  verifyCanonicalRealpath(runDirectory, context)
  let descriptor: number | null = null
  try {
    descriptor = Fs.openSync(runDirectory, DirectoryOpenFlags)
    const opened = Fs.fstatSync(descriptor, { bigint: true }),
      current = Fs.lstatSync(runDirectory, { bigint: true })
    if (
      !sameVerifierIdentity(
        verifierIdentity(before),
        verifierIdentity(opened)
      ) ||
      !sameVerifierIdentity(verifierIdentity(opened), verifierIdentity(current))
    ) {
      context.issue(
        RunEvidenceVerificationIssueCode.RootChanged,
        "$run",
        "run root changed while opening its descriptor"
      )
      return null
    }
    const pinnedRoot: PinnedDirectory = {
        relativePath: "",
        descriptor,
        identity: verifierIdentity(opened),
        parent: null,
        basename: null
      },
      root: PinnedRunDirectory = {
        path: runDirectory,
        root: pinnedRoot,
        directories: new Map([["", pinnedRoot]]),
        openedDirectories: [pinnedRoot]
      }
    descriptor = null
    return root
  } catch (error) {
    context.issue(
      RunEvidenceVerificationIssueCode.ReadFailed,
      "$run",
      `run directory descriptor open failed: ${verifierErrorText(error)}`
    )
    return null
  } finally {
    if (descriptor !== null) closeTemporaryRoot(descriptor, context)
  }
}

function inspectExplicitRoot(
  runDirectory: string,
  context: RunEvidenceVerificationContext
): Fs.BigIntStats | null {
  let stat: Fs.BigIntStats
  try {
    stat = Fs.lstatSync(runDirectory, { bigint: true })
  } catch (error) {
    throw new RunEvidenceVerifierInvocationError(
      runDirectory,
      `run directory cannot be inspected: ${verifierErrorText(error)}`
    )
  }
  if (stat.isSymbolicLink()) {
    context.issue(
      RunEvidenceVerificationIssueCode.RootSymlink,
      "$run",
      "run directory is a symbolic link"
    )
    return null
  }
  if (stat.isDirectory()) return stat
  context.issue(
    RunEvidenceVerificationIssueCode.RootNotDirectory,
    "$run",
    "run directory is not a directory"
  )
  return null
}

function inspectRunComponents(
  runDirectory: string,
  context: RunEvidenceVerificationContext
): void {
  const parsed = Path.parse(runDirectory),
    parts = runDirectory
      .slice(parsed.root.length)
      .split(Path.sep)
      .filter(Boolean)
  parts.reduce((current, part, index) => {
    const next = Path.join(current, part)
    try {
      const stat = Fs.lstatSync(next, { bigint: true })
      if (stat.isSymbolicLink()) {
        context.issue(
          index === parts.length - 1
            ? RunEvidenceVerificationIssueCode.RootSymlink
            : RunEvidenceVerificationIssueCode.AncestorSymlink,
          "$run",
          `symbolic-link component: ${next}`
        )
      } else if (!stat.isDirectory()) {
        context.issue(
          RunEvidenceVerificationIssueCode.RootNotDirectory,
          "$run",
          `non-directory component: ${next}`
        )
      }
    } catch (error) {
      context.issue(
        RunEvidenceVerificationIssueCode.ReadFailed,
        "$run",
        `component inspection failed: ${verifierErrorText(error)}`
      )
    }
    return next
  }, parsed.root)
}

function verifyCanonicalRealpath(
  runDirectory: string,
  context: RunEvidenceVerificationContext
): void {
  try {
    if (Fs.realpathSync.native(runDirectory) !== runDirectory)
      context.issue(
        RunEvidenceVerificationIssueCode.NonCanonicalRoot,
        "$run",
        "run directory realpath differs from the explicit path"
      )
  } catch (error) {
    context.issue(
      RunEvidenceVerificationIssueCode.ReadFailed,
      "$run",
      `run directory realpath failed: ${verifierErrorText(error)}`
    )
  }
}

function closeTemporaryRoot(
  descriptor: number,
  context: RunEvidenceVerificationContext
): void {
  try {
    Fs.closeSync(descriptor)
  } catch (error) {
    context.issue(
      RunEvidenceVerificationIssueCode.ReadFailed,
      "$run",
      `run descriptor close failed: ${verifierErrorText(error)}`
    )
  }
}
