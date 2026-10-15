import { ConnectionProfileDefaults, ConnectionProfileForm } from "@wireio/ql-shared"

import { FixtureEndpoint as Endpoint } from "../common/profileFixtures.js"

describe("ConnectionProfileForm", () => {
  it("empty() shows the defaults and leaves the server deadline / owners blank", () => {
    expect(ConnectionProfileForm.empty()).toEqual({
      name: "",
      endpoint: "",
      transportTimeoutMs: String(ConnectionProfileDefaults.TransportTimeoutMs),
      queryTimeoutMs: "",
      retries: String(ConnectionProfileDefaults.Retries),
      owners: ""
    })
  })

  it("of() round-trips through toProfile()", () => {
    const profile = { name: "local", endpoint: Endpoint, transportTimeoutMs: 5_000, queryTimeoutMs: 700, retries: 1, owners: ["a", "b"] },
      form = ConnectionProfileForm.of(profile)
    expect(form).toEqual({ name: "local", endpoint: Endpoint, transportTimeoutMs: "5000", queryTimeoutMs: "700", retries: "1", owners: "a,b" })
    expect(ConnectionProfileForm.toProfile(form).getOrThrow()).toEqual(profile)
  })

  it("toProfile() trims, splits owners, and omits a blank deadline / owner list", () => {
    const profile = ConnectionProfileForm.toProfile({ ...ConnectionProfileForm.empty(), name: " local ", endpoint: ` ${Endpoint} `, owners: " , " }).getOrThrow()
    expect(profile).toEqual({
      name: "local",
      endpoint: Endpoint,
      transportTimeoutMs: ConnectionProfileDefaults.TransportTimeoutMs,
      retries: ConnectionProfileDefaults.Retries
    })
  })

  it("toProfile() rejects a non-http endpoint, a non-integer timeout and negative retries with field messages", () => {
    const base = { ...ConnectionProfileForm.empty(), name: "local", endpoint: Endpoint }
    expect(ConnectionProfileForm.toProfile({ ...base, endpoint: "ftp://x" }).getLeftOrThrow()).toMatch(/^endpoint: /)
    expect(ConnectionProfileForm.toProfile({ ...base, queryTimeoutMs: "1.5" }).getLeftOrThrow()).toMatch(/^queryTimeoutMs: /)
    expect(ConnectionProfileForm.toProfile({ ...base, retries: "-1" }).getLeftOrThrow()).toMatch(/^retries: /)
    expect(ConnectionProfileForm.toProfile({ ...base, name: " " }).getLeftOrThrow()).toMatch(/^name: /)
  })
})
