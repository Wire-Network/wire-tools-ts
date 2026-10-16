import Yargs from "yargs"

import { declaredDefaults } from "../../common/yargsIntrospection.js"

import { ConnectionProfileDefaults } from "@wireio/ql-shared"

import { applyConnectionArgs, ConnectionArgs } from "@wireio/ql-tool-cli/cli/index.js"

describe("applyConnectionArgs", () => {
  it("parses every connection flag (aliases included)", async () => {
    const argv = await applyConnectionArgs(Yargs(["-p", "local", "-u", "http://h.example", "--timeout-ms", "500", "--transport-timeout-ms", "9000", "--retries", "0", "--owners", "a", "--owners", "b"]).parserConfiguration({ "greedy-arrays": false })).parseAsync()
    expect(argv).toMatchObject({ profile: "local", url: "http://h.example", timeoutMs: 500, transportTimeoutMs: 9000, retries: 0, owners: ["a", "b"] })
  })

  it("leaves every flag undefined when not given (no yargs defaults)", async () => {
    const parser = applyConnectionArgs(Yargs([])),
      argv = await parser.parseAsync()
    expect([argv.profile, argv.url, argv.timeoutMs, argv.transportTimeoutMs, argv.retries, argv.owners]).toEqual([
      undefined, undefined, undefined, undefined, undefined, undefined
    ])
    expect(declaredDefaults(parser)).toEqual([])
  })

  it("documents the environment seeds and effective defaults", () => {
    expect(ConnectionArgs.UrlEnvVar).toBe("WIRE_QL_URL")
    expect(ConnectionArgs.ProfileEnvVar).toBe("WIRE_QL_PROFILE")
    expect(ConnectionProfileDefaults.TransportTimeoutMs).toBeGreaterThan(0)
  })

  it("profileOverrides maps only the given tuning flags onto profile members", () => {
    expect(ConnectionArgs.profileOverrides({})).toEqual({})
    expect(ConnectionArgs.profileOverrides({ profile: "p", url: "http://u.example" })).toEqual({})
    expect(ConnectionArgs.profileOverrides({ timeoutMs: 5, transportTimeoutMs: 6, retries: 0, owners: ["a"] })).toEqual({
      queryTimeoutMs: 5,
      transportTimeoutMs: 6,
      retries: 0,
      owners: ["a"]
    })
  })
})
