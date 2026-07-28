import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
// NOT the root barrel: it re-exports `FlowCLI` → yargs@18, which jest cannot
// require as ESM on Node < 24.9, so the whole suite would fail to load.
import { ClusterManager } from "@wireio/cluster-tool/cluster/ClusterManager"
import { ProcessManager } from "@wireio/cluster-tool/cluster/processes"
import type { ClusterBuild } from "@wireio/cluster-tool/orchestration"
import type { Report } from "@wireio/cluster-tool/report"
import { fixtureConfig } from "../config/clusterConfigFixture.js"

/**
 * `launch` must stop the daemons ITSELF, before its caller reaches
 * `process.exit()`. Deferring to the exit-handler sweep deadlocks the children:
 * that sweep is synchronous, so the event loop stops draining their stdio, and
 * nodeop blocks in `write(2)` inside spdlog's console sink while holding the
 * global console mutex (see `stopDaemonsWhileDraining`). Own file: the
 * process-manager cluster path is once-per-process, so this needs a fresh
 * module registry.
 */
describe("ClusterManager.launch — daemon stop", () => {
  // ONE root for the whole file: `ProcessManager.setClusterPath` is
  // once-per-process (it asserts on a second, different value).
  const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), "cluster-launch-stop-"))
  let order: string[]

  beforeEach(() => {
    order = []
    ProcessManager.setClusterPath(root)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  afterAll(() => {
    Fs.rmSync(root, { recursive: true, force: true })
  })

  /** A build stub — `launch` only reads `config` and calls `build()`. */
  function buildStub(succeeded = true) {
    // Every path the fixture carries must be rooted in the temp dir — `launch`
    // really lays the cluster down (dirs, genesis, per-node config).
    const config = fixtureConfig({
      clusterPath: root,
      dataPath: Path.join(root, "data"),
      walletPath: Path.join(root, "wallet"),
      report: { path: Path.join(root, "reports"), basename: "cluster-build", formats: [] }
    })
    return {
      config,
      build: async () => {
        order.push("build")
        return { succeeded } as unknown as Report
      }
    } as unknown as ClusterBuild
  }

  it("stops the daemons after producing the Report", async () => {
    const stopAll = jest
      .spyOn(ProcessManager.get(), "stopAll")
      .mockImplementation(async () => {
        order.push("stopAll")
      })

    const report = await ClusterManager.launch(buildStub())

    expect(report.succeeded).toBe(true)
    expect(stopAll).toHaveBeenCalledTimes(1)
    // Ordering is the whole point: the Report exists first, so a stop failure
    // can never mask it — and the stop happens before the caller can exit.
    expect(order).toEqual(["build", "stopAll"])
  })

  it("stops the daemons even when the build FAILED", async () => {
    const stopAll = jest
      .spyOn(ProcessManager.get(), "stopAll")
      .mockImplementation(async () => {
        order.push("stopAll")
      })

    const report = await ClusterManager.launch(buildStub(false))

    expect(report.succeeded).toBe(false)
    expect(stopAll).toHaveBeenCalledTimes(1)
  })

  it("still returns the Report when the graceful stop throws", async () => {
    jest
      .spyOn(ProcessManager.get(), "stopAll")
      .mockRejectedValue(new Error("stopAll blew up"))

    // The exit sweep remains the backstop; the run's verdict must survive.
    await expect(ClusterManager.launch(buildStub())).resolves.toMatchObject({
      succeeded: true
    })
  })
})
