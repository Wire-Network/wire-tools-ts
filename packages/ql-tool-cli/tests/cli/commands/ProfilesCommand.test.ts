import { ProfilesCommand, QLExitCode } from "@wireio/ql-tool-cli/cli/index.js"

import { runWql } from "../../common/runWql.js"
import { createTestContext } from "../../common/testContext.js"

describe("wql profiles", () => {
  it("adds, lists (default marked), defaults and removes profiles", async () => {
    const { context } = createTestContext()
    expect((await runWql(["profiles", "add", "local", "http://node.example", "--default", "--retries", "0"], context)).stdout).toEqual([
      "saved profile local"
    ])
    await runWql(["profiles", "add", "remote", "https://remote.example", "--timeout-ms", "500"], context)
    expect((await runWql(["profiles", "list"], context)).stdout).toEqual([
      "* local\thttp://node.example",
      "  remote\thttps://remote.example"
    ])
    expect(context.profileStore.get("local").retries).toBe(0)
    expect(context.profileStore.get("remote").queryTimeoutMs).toBe(500)
    await runWql(["profiles", "default", "remote"], context)
    expect(context.profileStore.read().defaultProfile).toBe("remote")
    await runWql(["profiles", "remove", "remote"], context)
    expect(context.profileStore.read()).toEqual({ defaultProfile: null, profiles: [expect.objectContaining({ name: "local" })] })
  })

  it("rejects an invalid endpoint (usage) and an unknown profile (failure)", async () => {
    const { context } = createTestContext()
    expect((await runWql(["profiles", "add", "bad", "ftp://x"], context)).exitCode).toBe(QLExitCode.usage)
    expect((await runWql(["profiles", "remove", "nope"], createTestContext().context)).exitCode).toBe(QLExitCode.failure)
  })

  it("formats a listing line", () => {
    expect(ProfilesCommand.profileLine({ name: "n", endpoint: "http://e.example", transportTimeoutMs: 1, retries: 0 }, false)).toBe("  n\thttp://e.example")
  })
})

describe("ProfilesCommand messages", () => {
  it("confirms a save, a removal and a new default by name", () => {
    expect(ProfilesCommand.savedText("local")).toBe("saved profile local")
    expect(ProfilesCommand.removedText("local")).toBe("removed profile local")
    expect(ProfilesCommand.defaultText("local")).toBe("default profile local")
  })
})
