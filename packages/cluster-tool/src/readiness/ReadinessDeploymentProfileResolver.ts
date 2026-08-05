import Fs from "node:fs"
import Path from "node:path"

import {
  type OutpostDeploymentProfile,
  parseOutpostDeploymentProfile
} from "@wireio/sdk-outpost"
import { NestedError } from "@wireio/shared"

/**
 * Read and validate one immutable outpost deployment profile.
 *
 * @param profileFile - JSON profile file supplied by the operator.
 * @returns The schema-validated deployment profile.
 */
export function resolveReadinessDeploymentProfile(
  profileFile: string
): OutpostDeploymentProfile {
  const resolvedProfileFile = Path.resolve(profileFile)
  try {
    const value: unknown = JSON.parse(
      Fs.readFileSync(resolvedProfileFile, "utf8")
    )
    return parseOutpostDeploymentProfile(value)
  } catch (error: unknown) {
    throw new NestedError("Unable to load outpost deployment profile", {
      cause: error,
      context: { profileFile: resolvedProfileFile }
    })
  }
}
