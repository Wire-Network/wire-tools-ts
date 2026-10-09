import { SysioContracts } from "@wireio/sdk-core"

import {
  ConnectionProfile,
  ConnectionProfileCodec,
  ConnectionProfileDefaults,
  ConnectionProfilesDocument,
  ConnectionProfilesDocumentCodec,
  ConnectionProfileSchema
} from "@wireio/ql-shared"

import { FixtureEndpoint } from "../common/profileFixtures.js"

describe("ConnectionProfile", () => {
  it("applies defaults (transport timeout, retries; no server deadline, no owners)", () => {
    const profile = ConnectionProfile.create({ name: "local", endpoint: FixtureEndpoint })
    expect(profile).toEqual({
      name: "local",
      endpoint: FixtureEndpoint,
      transportTimeoutMs: ConnectionProfileDefaults.TransportTimeoutMs,
      retries: ConnectionProfileDefaults.Retries
    })
    expect(profile.queryTimeoutMs).toBeUndefined()
  })

  it("resolves owners: custom list, else the read-time system-contract seed", () => {
    expect(ConnectionProfile.resolveOwners(ConnectionProfile.create({ name: "p", endpoint: "https://x", owners: ["a"] }))).toEqual(["a"])
    const seed = ConnectionProfile.resolveOwners(ConnectionProfile.create({ name: "p", endpoint: "https://x" }))
    expect(seed).toEqual(ConnectionProfileDefaults.owners())
    expect(new Set(seed).size).toBe(seed.length)
    expect(seed).toContain(SysioContracts.SysioContractAccount.opreg)
  })

  it("rejects invalid endpoints and unknown keys", () => {
    expect(ConnectionProfileSchema.safeParse({ name: "p", endpoint: "ftp://x" }).success).toBe(false)
    expect(ConnectionProfileSchema.safeParse({ name: "p", endpoint: "not a url" }).success).toBe(false)
    expect(ConnectionProfileSchema.safeParse({ name: "p", endpoint: "http://x", token: "secret" }).success).toBe(false)
    expect(ConnectionProfileSchema.safeParse({ name: "", endpoint: "http://x" }).success).toBe(false)
  })

  it("round-trips the profiles document with an explicit null default", () => {
    const document = ConnectionProfilesDocument.empty()
    expect(JSON.parse(ConnectionProfilesDocumentCodec.serialize(document))).toEqual({ defaultProfile: null, profiles: [] })
    const withProfile = { defaultProfile: "p", profiles: [ConnectionProfile.create({ name: "p", endpoint: "http://x", owners: ["a"] })] }
    expect(ConnectionProfilesDocumentCodec.deserialize(ConnectionProfilesDocumentCodec.serialize(withProfile))).toEqual(withProfile)
  })
})

describe("ConnectionProfileCodec", () => {
  it("validates + defaults a parsed profile and round-trips it", () => {
    const profile = ConnectionProfileCodec.validate({ name: "p", endpoint: FixtureEndpoint }).getOrThrow()
    expect(profile.retries).toBe(ConnectionProfileDefaults.Retries)
    expect(ConnectionProfileCodec.deserialize(ConnectionProfileCodec.serialize(profile))).toEqual(profile)
  })

  it("rejects an unknown member", () => {
    expect(ConnectionProfileCodec.validate({ name: "p", endpoint: "http://x", secret: "s" }).isLeft()).toBe(true)
  })
})
