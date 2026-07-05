import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { ClusterConfig } from "@wireio/cluster-tool/config"
import { fixtureConfig, PersistedFixture } from "./clusterConfigFixture.js"

describe("ClusterConfig", () => {
  describe("resolve", () => {
    it("fails fast when buildPath is missing", async () => {
      await expect(
        ClusterConfig.resolve({ clusterPath: "/c", ethereumPath: "/e", solanaPath: "/s" })
      ).rejects.toThrow(/buildPath is required/)
    })
    it("fails fast when clusterPath is missing", async () => {
      await expect(
        ClusterConfig.resolve({ buildPath: "/b", ethereumPath: "/e", solanaPath: "/s" })
      ).rejects.toThrow(/clusterPath is required/)
    })
  })

  describe("deserialize", () => {
    it("rehydrates a BindConfig instance with the persisted topology", () => {
      const cfg = fixtureConfig()
      expect(cfg.bind.nodeop.ports.batch).toHaveLength(3)
      expect(cfg.bind.nodeop.ports.bios.http).toBe(8788)
      expect(cfg.epochDurationSec).toBe(60)
      // BindConfig methods must exist (rebuilt as an instance, not a plain object)
      expect(typeof cfg.bind.validate).toBe("function")
      expect(cfg.bind.allPorts.length).toBeGreaterThan(0)
    })
  })

  describe("derived paths", () => {
    it("ethereumDeploymentsPath is per-cluster (under dataPath)", () => {
      const cfg = fixtureConfig()
      expect(cfg.ethereumDeploymentsPath).toBe(
        `${cfg.dataPath}/ethereum-deployments`
      )
    })
  })

  describe("serialize / deserialize round-trip", () => {
    it("preserves every scalar field", () => {
      const cfg = fixtureConfig()
      const round = ClusterConfig.deserialize(ClusterConfig.serialize(cfg))
      expect(round.buildPath).toBe(PersistedFixture.buildPath)
      expect(round.producerCount).toBe(PersistedFixture.producerCount)
      expect(round.report.formats).toEqual(PersistedFixture.report.formats)
      expect(round.bind.solana.ports.faucet).toBe(9900)
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
      const file = Path.join(dir, ClusterConfig.ConfigFilename)
      // Build a fixture whose clusterPath is the temp dir so save() lands there.
      const cfg = ClusterConfig.deserialize(
        JSON.stringify({
          ...PersistedFixture,
          clusterPath: dir
        })
      )
      const saved = await cfg.save()
      expect(saved).toBe(cfg)
      expect(Fs.existsSync(file)).toBe(true)
      const reloaded = ClusterConfig.loadSync(file)
      expect(reloaded.clusterPath).toBe(dir)
      expect(reloaded.bind.nodeop.ports.batch).toHaveLength(3)
    })
  })
})
