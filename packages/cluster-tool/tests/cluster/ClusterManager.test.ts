import { spawn } from "node:child_process"
import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { PidSources } from "@wireio/debugging-shared"
import { Deferred, guard } from "@wireio/shared"
import { ClusterManager } from "@wireio/cluster-tool"
import { ProcessSignalName } from "@wireio/cluster-tool/cluster/processes"
import { ClusterConfigProvider } from "@wireio/cluster-tool/config"
import { fixtureConfig } from "../config/clusterConfigFixture.js"

describe("ClusterManager.assertClusterStopped", () => {
  let dir: string

  beforeEach(() => {
    dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "cluster-manager-"))
  })

  afterEach(() => {
    Fs.rmSync(dir, { recursive: true, force: true })
  })

  /** A `ClusterConfig` rooted at the temp dir, with `dataPath` pointed at `dataPath`. */
  function configWithDataPath(dataPath: string) {
    return fixtureConfig({ clusterPath: dir, dataPath })
  }

  it("passes when the data dir does not exist", () => {
    expect(() =>
      ClusterManager.assertClusterStopped(configWithDataPath(Path.join(dir, "data")))
    ).not.toThrow()
  })

  it("passes when a pidfile is stale (its pid is no longer alive)", () => {
    const dataPath = Path.join(dir, "data"),
      nodeDirectory = Path.join(dataPath, "node_bios")
    Fs.mkdirSync(nodeDirectory, { recursive: true })
    // A pid number far past any real pid — guaranteed not alive (ESRCH).
    Fs.writeFileSync(Path.join(nodeDirectory, "node_bios.pid"), "987654321")
    expect(() => ClusterManager.assertClusterStopped(configWithDataPath(dataPath))).not.toThrow()
  })

  it("throws, naming the live pid, when a pidfile points at a still-running process", async () => {
    const child = spawn("/bin/sleep", ["300"], { stdio: "ignore" })
    try {
      const dataPath = Path.join(dir, "data"),
        nodeDirectory = Path.join(dataPath, "node_bios")
      Fs.mkdirSync(nodeDirectory, { recursive: true })
      Fs.writeFileSync(Path.join(nodeDirectory, "node_bios.pid"), String(child.pid))
      expect(() =>
        ClusterManager.assertClusterStopped(configWithDataPath(dataPath))
      ).toThrow(new RegExp(`live pid\\(s\\): ${child.pid}`))
    } finally {
      child.kill("SIGKILL")
      await new Promise<void>(resolve => child.once("exit", () => resolve()))
    }
  })
})

describe("ClusterManager.prepareClusterPath", () => {
  /** Node dir seeded under the cluster's data dir — the shape the scan walks. */
  const NodeName = "node_bios"
  /** Written into the cluster dir; its survival IS the "no wipe" assertion. */
  const MarkerFilename = "marker.txt"
  const MarkerContent = "pre-existing cluster content"
  /** A pid far past any real pid — guaranteed not alive (ESRCH). */
  const StalePid = 987_654_321

  let root: string, clusterPath: string, markerFile: string

  /**
   * A LIVE pid with a real child behind it (never incidental process
   * ancestry). It blocks on its stdin pipe, so it lives EXACTLY as long as
   * this worker: afterAll kills it on the normal path, and if the worker dies
   * any other way the pipe EOF drains its event loop and it exits on its own.
   * Deliberately NOT unref'd — a failed reap must show up as a leaked handle.
   */
  let liveChild: ReturnType<typeof spawn>

  beforeAll(() => {
    liveChild = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
      stdio: ["pipe", "ignore", "ignore"]
    })
    expect(liveChild.pid).toBeGreaterThan(0)
  })

  afterAll(async () => {
    // Await "close" (exit + stdio teardown), not "exit": the stdin pipe socket
    // and the child handle must be FULLY gone before the worker tears down.
    const closed = Deferred.useCallback<void>(deferred => {
      if (liveChild.exitCode != null || liveChild.signalCode != null) {
        deferred.resolve()
        return
      }
      liveChild.once("close", () => deferred.resolve())
    }).promise
    liveChild.stdin.destroy()
    // Best-effort signal — ESRCH if the child already exited.
    guard(() => process.kill(liveChild.pid, ProcessSignalName.SIGKILL))
    await closed
  })

  beforeEach(() => {
    root = Fs.mkdtempSync(Path.join(Os.tmpdir(), "cluster-manager-force-"))
    clusterPath = Path.join(root, "cluster")
    markerFile = Path.join(clusterPath, MarkerFilename)
    Fs.mkdirSync(clusterPath, { recursive: true })
    Fs.writeFileSync(markerFile, MarkerContent)
  })

  afterEach(() => {
    Fs.rmSync(root, { recursive: true, force: true })
  })

  /** Seed a pidfile exactly where the live-pid scan looks: `data/<node>/<node>.pid`. */
  function writePidFile(pid: number): void {
    const nodeDirectory = Path.join(
      clusterPath,
      ClusterConfigProvider.DataSubpath,
      NodeName
    )
    Fs.mkdirSync(nodeDirectory, { recursive: true })
    Fs.writeFileSync(
      Path.join(nodeDirectory, `${NodeName}${PidSources.PidExt}`),
      String(pid)
    )
  }

  it("removes the pre-existing cluster path when force is set", () => {
    ClusterManager.prepareClusterPath({ force: true, clusterPath })
    expect(Fs.existsSync(markerFile)).toBe(false)
    expect(Fs.existsSync(clusterPath)).toBe(false)
  })

  it("removes it when every pidfile is stale", () => {
    writePidFile(StalePid)
    ClusterManager.prepareClusterPath({ force: true, clusterPath })
    expect(Fs.existsSync(clusterPath)).toBe(false)
  })

  it("REFUSES an existing path without force, leaving it untouched", () => {
    // Never a silent overlay: the previous cluster's block logs, chain state
    // and stale pidfiles would be inherited under a freshly written genesis.
    expect(() => ClusterManager.prepareClusterPath({ clusterPath })).toThrow(
      /already exists .* pass --force to replace it/
    )
    expect(() =>
      ClusterManager.prepareClusterPath({ force: false, clusterPath })
    ).toThrow(/already exists .* pass --force to replace it/)
    expect(Fs.existsSync(markerFile)).toBe(true)
    expect(Fs.readFileSync(markerFile, "utf8")).toBe(MarkerContent)
  })

  it("refuses to remove a cluster whose pidfile names a LIVE pid", () => {
    writePidFile(liveChild.pid)
    expect(() =>
      ClusterManager.prepareClusterPath({ force: true, clusterPath })
    ).toThrow(new RegExp(`live pid\\(s\\): ${liveChild.pid}`))
    expect(Fs.existsSync(markerFile)).toBe(true)
  })

  it("is a no-op when the cluster path does not exist — with or without force", () => {
    const missing = Path.join(root, "never-created")
    expect(() =>
      ClusterManager.prepareClusterPath({ force: true, clusterPath: missing })
    ).not.toThrow()
    expect(() =>
      ClusterManager.prepareClusterPath({ clusterPath: missing })
    ).not.toThrow()
    expect(Fs.existsSync(missing)).toBe(false)
  })
})

describe("ClusterManager.destroy", () => {
  // ProcessManager.setClusterPath is once-per-process (idempotent for the same
  // value), so every destroy() in this file must target the SAME cluster root.
  const destroyRoot = Fs.mkdtempSync(Path.join(Os.tmpdir(), "cluster-manager-destroy-"))

  /** The shared-root `ClusterConfig`, its dataPath laid out like a real cluster. */
  function destroyConfig() {
    return fixtureConfig({
      clusterPath: destroyRoot,
      dataPath: Path.join(destroyRoot, "data")
    })
  }

  beforeEach(() => {
    Fs.mkdirSync(Path.join(destroyRoot, "data", "node_bios"), { recursive: true })
  })

  afterAll(() => {
    Fs.rmSync(destroyRoot, { recursive: true, force: true })
  })

  it("sets the process-manager cluster path itself and removes the cluster directory", async () => {
    await expect(ClusterManager.destroy(destroyConfig())).resolves.toBeUndefined()
    expect(Fs.existsSync(destroyRoot)).toBe(false)
  })

  it("prunes a stale pidfile via the orphan sweep and still removes the directory", async () => {
    // A pid number far past any real pid — guaranteed not alive (ESRCH).
    Fs.writeFileSync(
      Path.join(destroyRoot, "data", "node_bios", "node_bios.pid"),
      "987654321"
    )
    await expect(ClusterManager.destroy(destroyConfig())).resolves.toBeUndefined()
    expect(Fs.existsSync(destroyRoot)).toBe(false)
  })
})
