import { ConnectionProfileDefaults, QueryEngineClient, SchemaCatalog } from "@wireio/ql-shared"

import { CliContext, QLExitCode, QLUsageError } from "@wireio/ql-tool-cli/cli/index.js"

import { createTestContext } from "../../common/testContext.js"

describe("CliContext.resolveProfile", () => {
  it("uses --url alone as an ad-hoc profile named after the endpoint, with defaults", () => {
    const { context } = createTestContext(),
      profile = context.resolveProfile({ url: "http://node.example" })
    expect(profile).toMatchObject({
      name: "http://node.example",
      endpoint: "http://node.example",
      transportTimeoutMs: ConnectionProfileDefaults.TransportTimeoutMs,
      retries: ConnectionProfileDefaults.Retries
    })
    expect(profile.queryTimeoutMs).toBeUndefined()
  })

  it("resolves flag profile → env profile → default profile, with flag overrides on top", () => {
    const { context } = createTestContext({ env: { WIRE_QL_PROFILE: "env" } })
    context.profileStore.upsert({ name: "flag", endpoint: "http://flag.example" })
    context.profileStore.upsert({ name: "env", endpoint: "http://env.example" })
    context.profileStore.upsert({ name: "dflt", endpoint: "http://dflt.example" })
    context.profileStore.setDefault("dflt")
    expect(context.resolveProfile({ profile: "flag", timeoutMs: 250, retries: 0, owners: ["x"] })).toMatchObject({
      name: "flag",
      queryTimeoutMs: 250,
      retries: 0,
      owners: ["x"]
    })
    expect(context.resolveProfile({}).name).toBe("env")
    expect(createTestContextWithDefault().resolveProfile({}).name).toBe("dflt")
  })

  it("lets --url override a profile's endpoint and WIRE_QL_URL seed the endpoint without a profile flag", () => {
    const { context } = createTestContext({ env: { WIRE_QL_URL: "http://env-url.example" } })
    context.profileStore.upsert({ name: "p", endpoint: "http://p.example" })
    expect(context.resolveProfile({ profile: "p", url: "http://override.example" }).endpoint).toBe("http://override.example")
    expect(context.resolveProfile({ profile: "p" }).endpoint).toBe("http://p.example")
    expect(context.resolveProfile({}).endpoint).toBe("http://env-url.example")
  })

  it("treats empty environment seeds as unset", () => {
    const { context } = createTestContext({ env: { WIRE_QL_PROFILE: "", WIRE_QL_URL: "" } })
    expect(() => context.resolveProfile({})).toThrow(/no connection/)
    expect(CliContext.environmentValue({ X: "v" }, "X")).toBe("v")
    expect(CliContext.environmentValue({}, "X")).toBeUndefined()
  })

  it("rejects no connection, an unknown profile and an invalid URL as usage errors", () => {
    const { context } = createTestContext()
    expect(() => context.resolveProfile({})).toThrow(/wql profiles add/)
    expect(() => context.resolveProfile({ profile: "nope" })).toThrow(QLUsageError)
    expect(() => context.resolveProfile({ url: "ftp://x" })).toThrow(QLUsageError)
  })
})

describe("CliContext factories and members", () => {
  it("creates clients and catalogs for a profile", () => {
    const { context } = createTestContext(),
      profile = context.resolveProfile({ url: "http://node.example" })
    expect(context.createClient(profile)).toBeInstanceOf(QueryEngineClient)
    expect(context.createCatalog(profile)).toBeInstanceOf(SchemaCatalog)
    expect(context.exitCode).toBe(QLExitCode.success)
  })

  it("exposes the injected stdin and the default stores", () => {
    const { context } = createTestContext({ stdinText: "SELECT 1" })
    expect(context.queryTextSource.stdinIsTTY).toBe(false)
    expect(new CliContext().profileStore.file).toMatch(/profiles\.json$/)
  })
})

/** A context whose default profile is `dflt`. */
function createTestContextWithDefault(): CliContext {
  const { context } = createTestContext()
  context.profileStore.upsert({ name: "dflt", endpoint: "http://dflt.example" })
  context.profileStore.setDefault("dflt")
  return context
}
