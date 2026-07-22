import { createHash } from "node:crypto"

import type {
  EnvelopeBaseline,
  EnvelopeBaselineIdentity
} from "./EnvelopeIntegrityReaderTypes.js"

/**
 * Construct a canonical content-addressed all-sidecar-key baseline.
 *
 * @param baseKeys Every base key visible through either sidecar suffix.
 * @returns Sorted unique membership keys and their exact SHA-256 identity.
 */
export function createEnvelopeBaseline(
  baseKeys: readonly string[]
): EnvelopeBaseline {
  const sortedUniqueBaseKeys = [...new Set(baseKeys)].sort(),
    digest = createHash("sha256")
      .update(JSON.stringify(sortedUniqueBaseKeys), "utf8")
      .digest("hex"),
    identity: EnvelopeBaselineIdentity = `sha256:${digest}`
  return { identity, baseKeys: sortedUniqueBaseKeys }
}
