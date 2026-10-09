import { ConnectionProfile, type ConnectionProfileInput } from "@wireio/ql-shared"

/** Name of every fixture profile unless overridden. */
export const FixtureProfileName = "p"

/** Endpoint of every fixture profile unless overridden (never dialed, so portless: no bind-registry port is needed). */
export const FixtureEndpoint = "http://node.invalid"

/**
 * A validated profile (fixture name + endpoint unless overridden).
 *
 * @param overrides - Profile fields to replace.
 * @returns The profile.
 */
export function createProfile(overrides: Partial<ConnectionProfileInput> = {}): ConnectionProfile {
  return ConnectionProfile.create({ name: FixtureProfileName, endpoint: FixtureEndpoint, ...overrides })
}
