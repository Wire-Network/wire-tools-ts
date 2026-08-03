import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import type { ClusterConfig } from "@wireio/cluster-tool-shared"
import type { Argv } from "yargs"
import { ClusterConfigProvider } from "@wireio/cluster-tool/config"
import { PersistedFixture } from "../config/clusterConfigFixture.js"

// Preserve every other `ClusterManager` member — only `destroy` is faked.
//
// The fake is minted INSIDE the factory and bound below — never captured from a
// module-level `const`. `@wireio/cluster-tool`'s root barrel re-exports this
// module, so the factory runs while THIS file's own imports are still
// executing, and a captured binding would be read inside its temporal dead zone
// (jest's documented "a module factory may not reference out-of-scope
// variables" rule).
jest.mock("@wireio/cluster-tool/cluster/ClusterManager", () => ({
  ClusterManager: {
    ...(
      jest.requireActual(
        "@wireio/cluster-tool/cluster/ClusterManager"
      ) as typeof import("@wireio/cluster-tool/cluster/ClusterManager")
    ).ClusterManager,
    destroy: jest.fn()
  }
}))

import { ClusterCommand } from "@wireio/cluster-tool/cli/ClusterCommand"
import { createDestroyCommand } from "@wireio/cluster-tool/cli/DestroyCommand"
import { ClusterManager } from "@wireio/cluster-tool/cluster/ClusterManager"

const destroyMock = ClusterManager.destroy as jest.Mock

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

describe("createDestroyCommand", () => {
  let clusterPath: string
  let exitSpy: jest.SpiedFunction<typeof process.exit>

  beforeEach(() => {
    destroyMock.mockReset()
    clusterPath = Fs.mkdtempSync(
      Path.join(Os.tmpdir(), "wire-cluster-destroy-cmd-test-")
    )
    Fs.writeFileSync(
      Path.join(clusterPath, ClusterConfigProvider.ConfigFilename),
      JSON.stringify({ ...PersistedFixture, clusterPath })
    )
    exitSpy = jest
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never)
  })

  afterEach(() => {
    exitSpy.mockRestore()
    Fs.rmSync(clusterPath, { recursive: true, force: true })
  })

  it("names itself with the destroy enum member and carries a non-empty describe", () => {
    const module = createDestroyCommand()
    expect(module.command).toBe(ClusterCommand.destroy)
    expect(
      typeof module.describe === "string" && module.describe.length > 0
    ).toBe(true)
  })

  it("builder delegates to applyClusterPathArgs (registers --cluster-path)", () => {
    const { argv, options } = createYargsRecorder()
    createDestroyCommand().builder(argv)
    expect(options.get("cluster-path")).toMatchObject({
      type: "string",
      demandOption: true,
      alias: "d"
    })
  })

  it("loads the config, destroys the cluster, and exits 0", async () => {
    await createDestroyCommand().handler({ clusterPath })
    expect(destroyMock).toHaveBeenCalledTimes(1)
    const [config] = destroyMock.mock.calls[0] as [ClusterConfig]
    expect(config.clusterPath).toBe(clusterPath)
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it("propagates a load failure for a missing cluster directory", async () => {
    await expect(
      createDestroyCommand().handler({
        clusterPath: Path.join(clusterPath, "does-not-exist")
      })
    ).rejects.toThrow()
    expect(destroyMock).not.toHaveBeenCalled()
  })
})
