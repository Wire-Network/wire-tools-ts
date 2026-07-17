import type { Argv } from "yargs"
import { applyClusterPathArgs } from "@wireio/cluster-tool/cli/ClusterPathArgs"

// `yargs` is ESM-only (v18) and jest's CJS runtime can't load it (see
// ClusterBuildOptionsArgs.test.ts) — registration is exercised via a minimal
// `.option()` recorder, mirroring that file's established pattern.

/** One captured `.option(flag, config)` registration. */
interface RecordedOption {
  type?: string
  describe?: string
  demandOption?: boolean
  alias?: string
}

/** The recorder pair returned by {@link createYargsRecorder}. */
interface YargsRecorder {
  argv: Argv
  options: Map<string, RecordedOption>
}

/** A minimal `Argv` stand-in that records every `.option(flag, config)` call. */
function createYargsRecorder(): YargsRecorder {
  const options = new Map<string, RecordedOption>(),
    recorder = {
      option(flag: string, config: RecordedOption) {
        options.set(flag, config)
        return recorder
      }
    }
  return { argv: recorder as unknown as Argv, options }
}

describe("applyClusterPathArgs", () => {
  it("registers a required, string --cluster-path flag aliased -d", () => {
    const { argv, options } = createYargsRecorder()
    applyClusterPathArgs(argv)
    expect(options.get("cluster-path")).toMatchObject({
      type: "string",
      demandOption: true,
      alias: "d"
    })
  })

  it("carries a non-empty describe", () => {
    const { argv, options } = createYargsRecorder()
    applyClusterPathArgs(argv)
    const describe = options.get("cluster-path")?.describe
    expect(typeof describe === "string" && describe.length > 0).toBe(true)
  })

  it("returns the (chainable) builder it was given", () => {
    const { argv } = createYargsRecorder()
    expect(applyClusterPathArgs(argv)).toBe(argv)
  })
})
