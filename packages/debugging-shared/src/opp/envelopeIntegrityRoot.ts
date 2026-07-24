import * as Path from "node:path"

import {
  EnvelopeIntegrityIssueCode,
  type EnvelopeIntegrityDirectoryHandle,
  type EnvelopeIntegrityFileError,
  type EnvelopeIntegrityFileIdentity,
  type EnvelopeIntegrityFileSystem,
  type EnvelopeIntegrityIssue,
  type EnvelopeIntegrityIssueSequence
} from "./EnvelopeIntegrityReaderTypes.js"
import { normalizeUnknownError } from "./envelopeIntegrityError.js"
import { fileIdentity, sameIdentity } from "./envelopeIntegrityFileIdentity.js"
import {
  emptyFileIdentity,
  rootChangedIssue,
  rootReadIssue
} from "./envelopeIntegrityIssues.js"
import type {
  PinEnvelopeStorageRootResult,
  PinnedEnvelopeStorageRoot,
  RootComponentIdentity
} from "./envelopeIntegrityRootTypes.js"

export type { PinnedEnvelopeStorageRoot } from "./envelopeIntegrityRootTypes.js"

const StorageScopeBaseKey = "$storage"

/**
 * Validate every root component and retain a no-follow directory descriptor.
 * @param storageRoot Resolved storage-root pathname.
 * @param fileSystem Typed filesystem seam.
 * @returns Pinned physical root or structured containment issues.
 */
export async function pinEnvelopeStorageRoot(
  storageRoot: string,
  fileSystem: EnvelopeIntegrityFileSystem
): Promise<PinEnvelopeStorageRootResult> {
  const components = storageComponents(storageRoot),
    componentStats = await Promise.all(
      components.map(async (path, index) => {
        try {
          return {
            kind: "stat" as const,
            path,
            index,
            stat: await fileSystem.lstat(path)
          }
        } catch (error) {
          return {
            kind: "failed" as const,
            path,
            index,
            error: normalizeUnknownError(
              error,
              index === components.length - 1 ? "root_lstat" : "ancestor_lstat"
            )
          }
        }
      })
    ),
    failed = componentStats.find(result => result.kind === "failed")
  if (failed?.kind === "failed")
    return rootReadIssue(storageRoot, failed.path, failed.error)
  const symlink = componentStats.find(
    result => result.kind === "stat" && result.stat.isSymbolicLink()
  )
  if (symlink?.kind === "stat") {
    return pinIssue({
      code:
        symlink.index === components.length - 1
          ? EnvelopeIntegrityIssueCode.StorageRootSymlink
          : EnvelopeIntegrityIssueCode.StorageAncestorSymlink,
      baseKey: StorageScopeBaseKey,
      context: { path: symlink.path }
    })
  }
  const nonDirectory = componentStats.find(
    result => result.kind === "stat" && !result.stat.isDirectory()
  )
  if (nonDirectory?.kind === "stat") {
    return pinIssue({
      code: EnvelopeIntegrityIssueCode.StorageRootNotDirectory,
      baseKey: StorageScopeBaseKey,
      context: { path: nonDirectory.path }
    })
  }

  try {
    const canonical = await fileSystem.realpath(storageRoot)
    if (canonical !== storageRoot) {
      return rootChangedIssue(storageRoot, emptyFileIdentity(), null, null)
    }
  } catch (error) {
    return rootReadIssue(
      storageRoot,
      storageRoot,
      normalizeUnknownError(error, "root_realpath")
    )
  }

  const identities = componentStats.flatMap(result =>
    result.kind === "stat"
      ? [{ path: result.path, identity: fileIdentity(result.stat) }]
      : []
  )
  let handle: EnvelopeIntegrityDirectoryHandle
  try {
    handle = await fileSystem.openDirectory(storageRoot)
  } catch (error) {
    return rootReadIssue(
      storageRoot,
      storageRoot,
      normalizeUnknownError(error, "root_open")
    )
  }
  try {
    const stat = await handle.stat(),
      identity = fileIdentity(stat),
      pathIdentity = identities.find(
        value => value.path === storageRoot
      )?.identity
    if (!stat.isDirectory()) {
      return closePinFailure(
        storageRoot,
        handle,
        pinIssue({
          code: EnvelopeIntegrityIssueCode.StorageRootNotDirectory,
          baseKey: StorageScopeBaseKey,
          context: { path: storageRoot }
        }).issues
      )
    }
    if (pathIdentity === undefined || !sameIdentity(pathIdentity, identity)) {
      return closePinFailure(
        storageRoot,
        handle,
        rootChangedIssue(
          storageRoot,
          pathIdentity ?? emptyFileIdentity(),
          identity,
          null
        ).issues
      )
    }
    return {
      kind: "pinned",
      root: { path: storageRoot, identity, components: identities, handle }
    }
  } catch (error) {
    return closePinFailure(
      storageRoot,
      handle,
      rootReadIssue(
        storageRoot,
        storageRoot,
        normalizeUnknownError(error, "root_stat")
      ).issues
    )
  }
}

/**
 * Close a retained storage-root descriptor.
 * @param root Pinned physical root.
 * @returns Null on success or a normalized root-close issue.
 */
export async function closeEnvelopeStorageRoot(
  root: PinnedEnvelopeStorageRoot
): Promise<EnvelopeIntegrityIssue | null> {
  const error = await closeRootHandle(root.handle)
  if (error === null) return null
  const [issue] = rootReadIssue(root.path, root.path, error).issues
  return issue
}

function storageComponents(storageRoot: string): readonly string[] {
  const parsed = Path.parse(storageRoot),
    segments = Path.relative(parsed.root, storageRoot)
      .split(Path.sep)
      .filter(Boolean)
  return segments.map((_, index) =>
    Path.join(parsed.root, ...segments.slice(0, index + 1))
  )
}

async function closePinFailure(
  storageRoot: string,
  handle: EnvelopeIntegrityDirectoryHandle,
  issues: EnvelopeIntegrityIssueSequence
): Promise<PinEnvelopeStorageRootResult> {
  const closeError = await closeRootHandle(handle)
  if (closeError === null) return { kind: "issue", issues }
  const [closeIssue] = rootReadIssue(
    storageRoot,
    storageRoot,
    closeError
  ).issues
  const [first, ...rest] = issues
  return { kind: "issue", issues: [first, ...rest, closeIssue] }
}

async function closeRootHandle(
  handle: EnvelopeIntegrityDirectoryHandle
): Promise<EnvelopeIntegrityFileError | null> {
  try {
    await handle.close()
    return null
  } catch (error) {
    return normalizeUnknownError(error, "root_close")
  }
}

function pinIssue(
  issue: EnvelopeIntegrityIssue
): Extract<PinEnvelopeStorageRootResult, { readonly kind: "issue" }> {
  return { kind: "issue", issues: [issue] }
}
