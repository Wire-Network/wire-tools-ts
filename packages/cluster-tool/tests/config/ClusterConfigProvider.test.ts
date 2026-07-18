import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import {
  BindConfigProvider,
  ClusterConfigProvider
} from "@wireio/cluster-tool/config"
import { fixtureConfig, PersistedFixture } from "./clusterConfigFixture.js"

describe("ClusterConfigProvider", () => {
  describe("resolve", () => {
    it("fails fast when buildPath is missing", async () => {
      await expect(
        ClusterConfigProvider.resolve({
          clusterPath: "/c",
          ethereumPath: "/e",
          solanaPath: "/s"
        })
      ).rejects.toThrow(/buildPath is required/)
    })
    it("fails fast when clusterPath is missing", async () => {
      await expect(
        ClusterConfigProvider.resolve({
          buildPath: "/b",
          ethereumPath: "/e",
          solanaPath: "/s"
        })
      ).rejects.toThrow(/clusterPath is required/)
    })
  })

  describe("deserialize", () => {
    it("rehydrates the persisted topology as the plain ClusterConfig shape", () => {
      const cfg = fixtureConfig()
      expect(cfg.bind.nodeop.ports.batch).toHaveLength(3)
      expect(cfg.bind.nodeop.ports.bios.http).toBe(
        BindConfigProvider.DefaultBiosHttp
      )
      expect(cfg.epochDurationSec).toBe(60)
      // Plain data end-to-end — BindConfigProvider owns behavior over the shape.
      expect(BindConfigProvider.allPorts(cfg.bind).length).toBeGreaterThan(0)
    })
  })

  describe("derived paths", () => {
    it("ethereumDeploymentsPath is per-cluster (under dataPath)", () => {
      const cfg = fixtureConfig()
      expect(ClusterConfigProvider.ethereumDeploymentsPath(cfg)).toBe(
        `${cfg.dataPath}/ethereum-deployments`
      )
    })
  })

  describe("serialize / deserialize round-trip", () => {
    it("preserves every scalar field", () => {
      const cfg = fixtureConfig()
      const round = ClusterConfigProvider.deserialize(
        ClusterConfigProvider.serialize(cfg)
      )
      expect(round.buildPath).toBe(PersistedFixture.buildPath)
      expect(round.producerCount).toBe(PersistedFixture.producerCount)
      expect(round.report.formats).toEqual(PersistedFixture.report.formats)
      expect(round.bind.solana.ports.faucet).toBe(
        BindConfigProvider.DefaultSolanaFaucet
      )
    })
  })

  describe("save / loadSync round-trip", () => {
    let dir: string
    beforeEach(() => {
      dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "clustercfg-"))
    })
    afterEach(() => {
      Fs.rmSync(dir, { recursive: true, force: true })
    })

    it("writes cluster-config.json and reloads it", async () => {
      const file = Path.join(dir, ClusterConfigProvider.ConfigFilename)
      // Build a fixture whose clusterPath is the temp dir so save() lands there.
      const cfg = ClusterConfigProvider.deserialize(
        JSON.stringify({
          ...PersistedFixture,
          clusterPath: dir
        })
      )
      const saved = await ClusterConfigProvider.save(cfg)
      expect(saved).toBe(cfg)
      expect(Fs.existsSync(file)).toBe(true)
      const reloaded = ClusterConfigProvider.loadSync(file)
      expect(reloaded.clusterPath).toBe(dir)
      expect(reloaded.bind.nodeop.ports.batch).toHaveLength(3)
    })
  })
})
