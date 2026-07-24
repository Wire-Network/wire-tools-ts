import type {
  EnvelopeIntegrityFileIdentity,
  EnvelopeIntegrityFileSystem,
  EnvelopeIntegrityIssue,
  EnvelopeIntegrityIssueSequence
} from "./EnvelopeIntegrityReaderTypes.js"
import { normalizeUnknownError } from "./envelopeIntegrityError.js"
import { fileIdentity, sameIdentity } from "./envelopeIntegrityFileIdentity.js"
import { rootChangedIssue } from "./envelopeIntegrityIssues.js"
import {
  closeEnvelopeStorageRoot,
  pinEnvelopeStorageRoot
} from "./envelopeIntegrityRoot.js"
import type { PinnedEnvelopeStorageRoot } from "./envelopeIntegrityRootTypes.js"

/**
 * Compare the current root and retained descriptor with the pinned identity.
 * @param root Pinned physical root.
 * @param fileSystem Typed filesystem seam.
 * @returns Null when stable, otherwise ordered root-verification issues.
 */
export async function verifyEnvelopeStorageRoot(
  root: PinnedEnvelopeStorageRoot,
  fileSystem: EnvelopeIntegrityFileSystem
): Promise<EnvelopeIntegrityIssueSequence | null> {
  try {
    const retained = fileIdentity(await root.handle.stat())
    if (!sameIdentity(root.identity, retained)) {
      return rootChangedIssue(root.path, root.identity, retained, null).issues
    }
  } catch (error) {
    return rootChangedIssue(
      root.path,
      root.identity,
      null,
      normalizeUnknownError(error, "root_verify_stat")
    ).issues
  }

  const componentIssues = await verifyRootComponents(root, fileSystem)
  if (componentIssues !== null) return componentIssues

  const current = await pinEnvelopeStorageRoot(root.path, fileSystem)
  if (current.kind === "issue") return current.issues
  const identityIssues = sameIdentity(root.identity, current.root.identity)
      ? null
      : rootChangedIssue(root.path, root.identity, current.root.identity, null)
          .issues,
    closeIssue = await closeEnvelopeStorageRoot(current.root)
  if (identityIssues === null) return closeIssue === null ? null : [closeIssue]
  return closeIssue === null
    ? identityIssues
    : appendIssue(identityIssues, closeIssue)
}

async function verifyRootComponents(
  root: PinnedEnvelopeStorageRoot,
  fileSystem: EnvelopeIntegrityFileSystem
): Promise<EnvelopeIntegrityIssueSequence | null> {
  const changed = await Promise.all(
    root.components.map(async component => {
      try {
        const stat = await fileSystem.lstat(component.path),
          current = fileIdentity(stat),
          identityMatches =
            component.path === root.path
              ? sameIdentity(component.identity, current)
              : sameNodeIdentity(component.identity, current)
        return stat.isDirectory() && !stat.isSymbolicLink() && identityMatches
          ? null
          : component
      } catch {
        return component
      }
    })
  )
  return changed.some(component => component !== null)
    ? rootChangedIssue(root.path, root.identity, null, null).issues
    : null
}

function sameNodeIdentity(
  left: EnvelopeIntegrityFileIdentity,
  right: EnvelopeIntegrityFileIdentity
): boolean {
  return (
    left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
  )
}

function appendIssue(
  issues: EnvelopeIntegrityIssueSequence,
  issue: EnvelopeIntegrityIssue
): EnvelopeIntegrityIssueSequence {
  const [first, ...rest] = issues
  return [first, ...rest, issue]
}
