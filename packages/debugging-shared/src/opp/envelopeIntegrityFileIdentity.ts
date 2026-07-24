import type {
  EnvelopeIntegrityFileIdentity,
  EnvelopeIntegrityFileStat
} from "./EnvelopeIntegrityReaderTypes.js"

/**
 * Convert BigInt stat identity into JSON-safe decimal strings.
 * @param stat Descriptor-bound stat result.
 * @returns Stable JSON-safe identity fields.
 */
export function fileIdentity(
  stat: EnvelopeIntegrityFileStat
): EnvelopeIntegrityFileIdentity {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode),
    nlink: String(stat.nlink),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs)
  }
}

/**
 * Compare every retained identity and drift field.
 * @param left Pinned identity.
 * @param right Current identity.
 * @returns True only when all identity fields match.
 */
export function sameIdentity(
  left: EnvelopeIntegrityFileIdentity,
  right: EnvelopeIntegrityFileIdentity
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
