import { asOption } from "@3fv/prelude-ts"
// lodash ships only a CJS entry — native ESM consumers (ink v5+, our TUI)
// can't destructure named exports from the default import in the import
// statement itself. Importing the default and destructuring at runtime
// works identically for TypeScript (esModuleInterop) and native Node ESM.
import { isString } from "@wireio/shared"

// Re-export generated types from @wireio/opp-typescript-models.
// The debugging protos (sysio/opp/debugging/) are compiled into the
// same package as the rest of the OPP types.
import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"

/**
 * Derive the endpoints key string used in storage filenames.
 * Uses the enum's own reverse mapping — no manual string table to maintain.
 */
export function endpointsTypeToKey(
  type: DebugOutpostEndpointsType
): string | null {
  return asOption(DebugOutpostEndpointsType[type]).filter(isString).getOrNull()
}
