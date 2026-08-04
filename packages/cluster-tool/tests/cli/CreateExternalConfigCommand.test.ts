import type { Argv } from "yargs"
import { ClusterCommand } from "@wireio/cluster-tool/cli/ClusterCommand"
import { createCreateExternalConfigCommand } from "@wireio/cluster-tool/cli/CreateExternalConfigCommand"

/** A captured `.option()` config — only the fields this suite asserts on. */
interface RecordedOption {
  type?: string
  demandOption?: boolean
}

/** The recorder pair returned by {@link createYargsRecorder}. */
interface YargsRecorder {
  argv: Argv
  options: Map<string, RecordedOption>
}

/** A minimal `.option()`-recording `Argv` stand-in (yargs is ESM-only; see
 *  CreateCommand.test.ts / ClusterBuildOptionsArgs.test.ts). */
function createYargsRecorder(): YargsRecorder {
  const options = new Map<string, RecordedOption>(),
    recorder = {
      option(flag: string, config: RecordedOption) {
        options.set(flag, config)
        return recorder
      },
      // The builder chains `.parserConfiguration(...)` before `.option(...)`
      // (keeps `--no-debugging-server` a plain flag, per commit 9297687f); the
      // recorder passes it through so the chain resolves — this suite asserts
      // only on the recorded `.option()` calls.
      parserConfiguration() {
        return recorder
      }
    }
  return { argv: recorder as unknown as Argv, options }
}

describe("createCreateExternalConfigCommand", () => {
  it("names itself with the create-external-config enum member and carries a non-empty describe", () => {
    const module = createCreateExternalConfigCommand()
    expect(module.command).toBe(ClusterCommand["create-external-config"])
    expect(
      typeof module.describe === "string" && module.describe.length > 0
    ).toBe(true)
  })

  it("builder registers the two cluster paths + the external bind config, all required strings", () => {
    const { argv, options } = createYargsRecorder()
    createCreateExternalConfigCommand().builder(argv)
    for (const flag of [
      "local-cluster-path",
      "external-cluster-path",
      "external-bind-config"
    ]) {
      const option = options.get(flag)
      expect(option).toBeDefined()
      expect(option.type).toBe("string")
      expect(option.demandOption).toBe(true)
    }
  })

  it("does NOT register the shared create flag surface (it is a two-path clone command, not a bootstrap)", () => {
    const { argv, options } = createYargsRecorder()
    createCreateExternalConfigCommand().builder(argv)
    expect(options.has("build-path")).toBe(false)
    expect(options.has("cluster-path")).toBe(false)
    expect(options.has("external-outpost-config")).toBe(false)
  })
})
