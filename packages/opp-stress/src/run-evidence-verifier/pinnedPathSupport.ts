import * as Fs from "node:fs"
import * as Path from "node:path"

import { RunEvidenceVerificationIssueCode } from "../runEvidenceVerifierTypes.js"
import { RunEvidenceVerificationContext } from "./verifierIssues.js"

/** Exact decimal-string filesystem identity captured from bigint stat fields. */
export type VerifierFileIdentity = {
  readonly dev: string
  readonly ino: string
  readonly mode: string
  readonly nlink: string
  readonly size: string
  readonly mtimeNs: string
  readonly ctimeNs: string
}

/** One held no-follow directory descriptor and its anchored parent entry. */
export type PinnedDirectory = {
  readonly relativePath: string
  readonly descriptor: number
  readonly identity: VerifierFileIdentity
  readonly parent: PinnedDirectory | null
  readonly basename: string | null
}

/** Descriptor-rooted run tree used by every verifier operation. */
export type PinnedRunDirectory = {
  readonly path: string
  readonly root: PinnedDirectory
  readonly directories: Map<string, PinnedDirectory>
  readonly openedDirectories: PinnedDirectory[]
}

/** Validate and resolve a portable reference for diagnostics only. */
export function containedRunPath(
  root: PinnedRunDirectory,
  relativePath: string,
  context: RunEvidenceVerificationContext
): string | null {
  if (!isPortableRunPath(relativePath)) {
    context.issue(
      RunEvidenceVerificationIssueCode.PathOutsideRun,
      relativePath,
      "path is not a normalized portable run-relative reference"
    )
    return null
  }
  return Path.join(root.path, ...relativePath.split("/"))
}

/** Resolve a held parent directory plus basename for one portable entry. */
export function pinnedEntry(
  root: PinnedRunDirectory,
  relativePath: string,
  context: RunEvidenceVerificationContext
): { readonly parent: PinnedDirectory; readonly basename: string } | null {
  if (containedRunPath(root, relativePath, context) === null) return null
  const directory = Path.posix.dirname(relativePath),
    parent = root.directories.get(directory === "." ? "" : directory)
  if (parent === undefined) {
    context.issue(
      RunEvidenceVerificationIssueCode.ReadFailed,
      relativePath,
      "parent directory was not pinned"
    )
    return null
  }
  return { parent, basename: Path.posix.basename(relativePath) }
}

/** Return a Linux descriptor-relative path that cannot traverse a replaced ancestor. */
export function descriptorEntryPath(
  directory: PinnedDirectory,
  basename?: string
): string {
  const root = `/proc/self/fd/${directory.descriptor}`
  return basename === undefined ? root : `${root}/${basename}`
}

/** Project exact bigint stat fields used for replacement detection. */
export function verifierIdentity(stat: Fs.BigIntStats): VerifierFileIdentity {
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    mode: stat.mode.toString(),
    nlink: stat.nlink.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString()
  }
}

/** Compare complete exact verifier identity snapshots. */
export function sameVerifierIdentity(
  left: VerifierFileIdentity,
  right: VerifierFileIdentity
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

/** Normalize unknown filesystem failures for deterministic issue details. */
export function verifierErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isPortableRunPath(relativePath: string): boolean {
  return (
    relativePath.length > 0 &&
    !relativePath.includes("\\") &&
    !Path.posix.isAbsolute(relativePath) &&
    Path.posix.normalize(relativePath) === relativePath &&
    !relativePath.startsWith("../")
  )
}
