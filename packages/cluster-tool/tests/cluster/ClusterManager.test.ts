import { spawn } from "node:child_process"
import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { ClusterManager } from "@wireio/cluster-tool"
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
