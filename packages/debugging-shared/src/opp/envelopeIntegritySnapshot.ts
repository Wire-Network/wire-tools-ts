import type {
  EnvelopeIntegrityDirectoryHandle,
  EnvelopeIntegrityFileError
} from "./EnvelopeIntegrityReaderTypes.js"
import { normalizeUnknownError } from "./envelopeIntegrityError.js"
import { compareCodeUnits } from "./envelopeIntegritySidecarScan.js"

/** Outcome of rereading one retained-root filename generation. */
export type EnvelopeSnapshotValidationResult =
  | { readonly kind: "stable" }
  | { readonly kind: "changed" }
  | { readonly kind: "failed"; readonly error: EnvelopeIntegrityFileError }

/**
 * Compare a fresh descriptor-anchored filename set with its initial snapshot.
 * @param root Retained storage-root capability.
 * @param expected Sorted complete filename snapshot.
 * @returns Stable, changed, or normalized readdir failure.
 */
export async function revalidateEnvelopeSidecarSnapshot(
  root: EnvelopeIntegrityDirectoryHandle,
  expected: readonly string[]
): Promise<EnvelopeSnapshotValidationResult> {
  try {
    const current = [...(await root.readdir())].sort(compareCodeUnits)
    return current.length === expected.length &&
      current.every((filename, index) => filename === expected[index])
      ? { kind: "stable" }
      : { kind: "changed" }
  } catch (error) {
    return { kind: "failed", error: normalizeUnknownError(error, "readdir") }
  }
}
