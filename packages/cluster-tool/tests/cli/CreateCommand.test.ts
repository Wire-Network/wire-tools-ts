import type { Argv } from "yargs"

const createMock = jest.fn()

// Preserve every other `ClusterManager` member (launch/stop/destroy) via the
// real module — only `create` is faked, mirroring the established
// `jest.requireActual` spread pattern (see BindConfig.test.ts's netUtils mock).
jest.mock("@wireio/cluster-tool/cluster/ClusterManager", () => ({
  ClusterManager: {
    ...(
      jest.requireActual(
        "@wireio/cluster-tool/cluster/ClusterManager"
      ) as typeof import("@wireio/cluster-tool/cluster/ClusterManager")
    ).ClusterManager,
    create: createMock
  }
}))

import { ClusterCommand } from "@wireio/cluster-tool/cli/ClusterCommand"
import { createCreateCommand } from "@wireio/cluster-tool/cli/CreateCommand"

/** The recorder pair returned by {@link createYargsRecorder}. */
interface YargsRecorder {
  argv: Argv
  options: Map<string, unknown>
}

/** A minimal `.option()`-recording `Argv` stand-in (yargs is ESM-only; see
 *  ClusterBuildOptionsArgs.test.ts). */
function createYargsRecorder(): YargsRecorder {
  const options = new Map<string, unknown>(),
    recorder = {
      option(flag: string, config: unknown) {
        options.set(flag, config)
        return recorder
      }
    }
  return { argv: recorder as unknown as Argv, options }
}

describe("createCreateCommand", () => {
  let exitSpy: jest.SpiedFunction<typeof process.exit>

  beforeEach(() => {
    createMock.mockReset()
    exitSpy = jest.spyOn(process, "exit").mockImplementation((() => undefined) as never)
  })

  afterEach(() => {
    exitSpy.mockRestore()
  })

  it("names itself with the create enum member and carries a non-empty describe", () => {
    const module = createCreateCommand()
    expect(module.command).toBe(ClusterCommand.create)
    expect(
      typeof module.describe === "string" && module.describe.length > 0
    ).toBe(true)
  })

  it("builder delegates to applyClusterBuildOptionsArgs (registers the shared flag surface)", () => {
    const { argv, options } = createYargsRecorder()
    createCreateCommand().builder(argv)
    expect(options.has("cluster-path")).toBe(true)
    expect(options.has("build-path")).toBe(true)
    expect(options.has("epoch-duration-sec")).toBe(true)
  })

  it("exits 0 and logs SUCCEEDED when the bootstrap report succeeded", async () => {
    createMock.mockResolvedValue({ succeeded: true })
    await createCreateCommand().handler({
      "cluster-path": "/tmp/wire-cluster",
      "build-path": "/tmp/wire-build",
      "ethereum-path": "/tmp/wire-eth",
      "solana-path": "/tmp/wire-sol"
    })
    expect(createMock).toHaveBeenCalledTimes(1)
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it("exits 1 when the bootstrap report did not succeed", async () => {
    createMock.mockResolvedValue({ succeeded: false })
    await createCreateCommand().handler({})
    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})
