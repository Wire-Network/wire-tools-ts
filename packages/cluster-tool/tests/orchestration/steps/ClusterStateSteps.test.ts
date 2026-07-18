import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { KeyType } from "@wireio/sdk-core"

import { ClusterState } from "@wireio/cluster-tool"
import { Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { fixtureContext } from "../../config/clusterBuildContextFixture.js"

describe("Steps.clusterState", () => {
  it("planPersist builds an input-less step with a runner", () => {
    const step = Steps.clusterState.planPersist(
      Report.Actor.Sysio,
      "persist-cluster-state",
      "persist cluster-state.json + cluster-keys.json",
      {}
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.input).toBeNull()
    expect(typeof step.runner).toBe("function")
  })

  describe("runPersist", () => {
    let dir: string

    beforeEach(() => {
      dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "cluster-state-steps-"))
    })

    afterEach(() => {
      Fs.rmSync(dir, { recursive: true, force: true })
    })

    it("writes both cluster-state.json and cluster-keys.json from the seeded context", async () => {
      const ctx = fixtureContext({
        clusterPath: dir,
        dataPath: Path.join(dir, "data"),
        walletPath: Path.join(dir, "wallet")
      })
      ctx.keyStore.pushNodes({
        index: 0,
        keys: {
          k1: {
            type: KeyType.K1,
            publicKey: "PUB_K1_node0",
            privateKey: "PVT_K1_node0"
          },
          bls: {
            type: KeyType.BLS,
            publicKey: "PUB_BLS_node0",
            privateKey: "PVT_BLS_node0",
            proofOfPossession: "SIG_BLS_node0"
          }
        }
      })

      await Steps.clusterState.runPersist(
        ctx,
        null,
        new AbortController().signal
      )

      expect(Fs.existsSync(ClusterState.stateFilePath(ctx.config))).toBe(true)
      expect(Fs.existsSync(ClusterState.keysFilePath(ctx.config))).toBe(true)
      const loadedState = ClusterState.load(ctx.config)
      expect(loadedState.walletPath).toBe(ctx.config.walletPath)
      const loadedKeys = ClusterState.loadKeys(ctx.config)
      expect(loadedKeys.nodes[0]?.k1.publicKey).toBe("PUB_K1_node0")
    })

    it("short-circuits on an already-aborted signal — neither file is written", async () => {
      const ctx = fixtureContext({
        clusterPath: dir,
        dataPath: Path.join(dir, "data"),
        walletPath: Path.join(dir, "wallet")
      })
      const controller = new AbortController()
      controller.abort()

      await expect(
        Steps.clusterState.runPersist(ctx, null, controller.signal)
      ).rejects.toThrow()

      expect(Fs.existsSync(ClusterState.stateFilePath(ctx.config))).toBe(false)
      expect(Fs.existsSync(ClusterState.keysFilePath(ctx.config))).toBe(false)
    })
  })
})
