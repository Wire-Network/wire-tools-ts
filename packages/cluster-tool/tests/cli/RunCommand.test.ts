import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import type { ClusterConfig } from "@wireio/cluster-tool-shared"
import type { Argv } from "yargs"
import { Deferred } from "@wireio/shared"
import { ClusterConfigProvider } from "@wireio/cluster-tool/config"
import { PersistedFixture } from "../config/clusterConfigFixture.js"

// Preserve every other `ClusterManager` member (create/launch/stop/destroy) via
// the real module — only `run` is faked, mirroring the established
// `jest.requireActual` spread pattern (see BindConfigProvider.test.ts's netUtils mock).
//
// Each fake is minted INSIDE its factory and bound below — never captured from
// a module-level `const`. `@wireio/cluster-tool`'s root barrel re-exports both
// of these modules, so the factories run while THIS file's own imports are
// still executing, and a captured binding would be read inside its temporal
// dead zone (jest's documented "a module factory may not reference out-of-scope
// variables" rule).
jest.mock("@wireio/cluster-tool/cluster/ClusterManager", () => ({
  ClusterManager: {
    ...(
      jest.requireActual(
        "@wireio/cluster-tool/cluster/ClusterManager"
      ) as typeof import("@wireio/cluster-tool/cluster/ClusterManager")
    ).ClusterManager,
    run: jest.fn()
  }
}))

jest.mock("@wireio/cluster-tool/cluster/ClusterKeepAlive", () => ({
  ClusterKeepAlive: { create: jest.fn() }
}))

import { ClusterCommand } from "@wireio/cluster-tool/cli/ClusterCommand"
import { createRunCommand } from "@wireio/cluster-tool/cli/RunCommand"
import { ClusterKeepAlive } from "@wireio/cluster-tool/cluster/ClusterKeepAlive"
import { ClusterManager } from "@wireio/cluster-tool/cluster/ClusterManager"

const runMock = ClusterManager.run as jest.Mock,
  createKeepAliveMock = ClusterKeepAlive.create as jest.Mock

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
  return { argv: recorder as Argv, options }
}

/** Flush pending microtasks so async code past an already-resolved `await`
 *  (e.g. the handler's statements between `ClusterManager.run` resolving and
 *  it reaching the keep-alive park) has actually executed before asserting. */
function flushMicrotasks(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

describe("createRunCommand", () => {
  let clusterPath: string
  let keepAliveDeferred: Deferred<void>
  let releaseMock: jest.Mock

  beforeEach(() => {
    runMock.mockReset()
    createKeepAliveMock.mockReset()
    keepAliveDeferred = new Deferred<void>()
    releaseMock = jest.fn(() => keepAliveDeferred.resolveIfUnsettled())
    createKeepAliveMock.mockReturnValue({
      wait: () => keepAliveDeferred.promise,
      release: releaseMock
    })
    clusterPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), "wire-cluster-run-cmd-test-"))
    Fs.writeFileSync(
      Path.join(clusterPath, ClusterConfigProvider.ConfigFilename),
      JSON.stringify({ ...PersistedFixture, clusterPath })
    )
  })

  afterEach(() => {
    Fs.rmSync(clusterPath, { recursive: true, force: true })
  })

  it("names itself with the run enum member and describes the create-only contract", () => {
    const module = createRunCommand()
    expect(module.command).toBe(ClusterCommand.run)
    expect(module.describe).toEqual(expect.stringContaining("wire-cluster-tool create"))
    expect(module.describe).toEqual(expect.stringContaining("not resumable"))
  })

  it("builder delegates to applyClusterPathArgs (registers --cluster-path)", () => {
    const { argv, options } = createYargsRecorder()
    createRunCommand().builder(argv)
    expect(options.get("cluster-path")).toMatchObject({
      type: "string",
      demandOption: true,
      alias: "d"
    })
  })

  it("loads the config, starts the cluster, and parks on the keep-alive until released", async () => {
    runMock.mockResolvedValue(undefined)
    const handled = createRunCommand().handler({ clusterPath })

    await flushMicrotasks()
    expect(runMock).toHaveBeenCalledTimes(1)
    const [config] = runMock.mock.calls[0] as [ClusterConfig]
    expect(config.clusterPath).toBe(clusterPath)
    expect(createKeepAliveMock).toHaveBeenCalledTimes(1)

    // Mirrors Ctrl+C's ProcessManager-driven teardown releasing the park.
    releaseMock()
    await expect(handled).resolves.toBeUndefined()
  })

  it("propagates a ClusterManager.run failure without ever parking (non-zero exit path)", async () => {
    const failure = new Error("epoch stall")
    runMock.mockRejectedValue(failure)

    await expect(createRunCommand().handler({ clusterPath })).rejects.toThrow("epoch stall")
    expect(createKeepAliveMock).not.toHaveBeenCalled()
  })
})
