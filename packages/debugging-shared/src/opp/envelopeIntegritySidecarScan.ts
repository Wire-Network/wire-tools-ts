import type {
  EnvelopeIntegrityDirectoryHandle,
  EnvelopeIntegrityFileError
} from "./EnvelopeIntegrityReaderTypes.js"
import { EnvelopeRecordFile } from "./EnvelopeRecordReader.js"
import { normalizeUnknownError } from "./envelopeIntegrityError.js"

/** Result of scanning the union of envelope sidecar extensions. */
export type EnvelopeSidecarScanResult =
  | {
      readonly kind: "scanned"
      readonly baseKeys: readonly string[]
      readonly filenames: ReadonlySet<string>
      readonly snapshot: readonly string[]
    }
  | { readonly kind: "failed"; readonly error: EnvelopeIntegrityFileError }

/**
 * Compare strings by JavaScript code units without locale state.
 * @param left Left evidence key.
 * @param right Right evidence key.
 * @returns Negative, zero, or positive ordering value.
 */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Discover all `.data` and `.metadata` base keys without validating them.
 * @param root Pinned storage-root descriptor.
 * @returns Sorted union scan or normalized readdir failure.
 */
export async function scanEnvelopeSidecars(
  root: EnvelopeIntegrityDirectoryHandle
): Promise<EnvelopeSidecarScanResult> {
  try {
    const snapshot = [...(await root.readdir())].sort(compareCodeUnits),
      baseKeys = [
        ...new Set(
          snapshot.flatMap(filename => {
            if (filename.endsWith(EnvelopeRecordFile.DataExt)) {
              return [filename.slice(0, -EnvelopeRecordFile.DataExt.length)]
            }
            if (filename.endsWith(EnvelopeRecordFile.MetadataExt)) {
              return [filename.slice(0, -EnvelopeRecordFile.MetadataExt.length)]
            }
            return []
          })
        )
      ].sort(compareCodeUnits)
    return {
      kind: "scanned",
      baseKeys,
      filenames: new Set(snapshot),
      snapshot
    }
  } catch (error) {
    return { kind: "failed", error: normalizeUnknownError(error, "readdir") }
  }
}
