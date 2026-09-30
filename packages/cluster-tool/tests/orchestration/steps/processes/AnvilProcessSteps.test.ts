import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import {
  AnvilProcess,
  ProcessManager
} from "@wireio/cluster-tool/cluster/processes"
import { Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { fixtureContext } from "../../../config/clusterBuildContextFixture.js"

describe("Steps.processes.anvil", () => {
  it.each(["planStart", "planEnableIntervalMining"] as const)(
    "%s builds an input-less step with a runner",
    factoryName => {
      const step = Steps.processes.anvil[factoryName](
        Report.Actor.EthereumOutpost,
        factoryName,
        `anvil ${factoryName}`,
        {}
      )
      expect(step.actor).toBe(Report.Actor.EthereumOutpost)
      expect(step.input).toBeNull()
      expect(typeof step.runner).toBe("function")
    }
  )

  /**
   * `runStart` spawns the ONE run-time anvil. `--slots-in-an-epoch` must ride the
   * spawn (anvil has no RPC to change it — without it `finalized` trails `latest`
   * by 64 blocks and every ETH→depot hop waits a minute), while `--block-time`
   * must NOT: the Hardhat deploy needs instamine, and interval mining is switched
   * on afterward by `planEnableIntervalMining`.
   */
  describe("runStart", () => {
    const signal = new AbortController().signal
    let dir: string

    // ProcessManager is a set-once singleton: one sandbox for the whole block.
    beforeAll(() => {
      dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "anvilsteps-"))
      ProcessManager.setClusterPath(dir)
    })
    afterEach(() => jest.restoreAllMocks())
    afterAll(() => {
      Fs.rmSync(dir, { recursive: true, force: true })
    })

    it("spawns anvil with the finality window and without interval mining", async () => {
      const ctx = fixtureContext({ clusterPath: dir, dataPath: Path.join(dir, "data") }),
        start = jest.fn(),
        anvil = { start } as Partial<AnvilProcess> as AnvilProcess,
        create = jest.spyOn(AnvilProcess, "create").mockResolvedValue(anvil)
      start.mockResolvedValue(anvil)

      await Steps.processes.anvil.runStart(ctx, null, signal)

      expect(create).toHaveBeenCalledTimes(1)
      const [manager, options] = create.mock.calls[0]
      expect(manager).toBe(ctx.processManager)
      expect(options).toMatchObject({
        host: ctx.config.bind.anvil.address,
        port: ctx.config.bind.anvil.port,
        chainId: AnvilProcess.DefaultChainId,
        slotsInAnEpoch: AnvilProcess.SlotsInAnEpoch
      })
      expect(options.blockTimeSec).toBeUndefined()
      expect(start).toHaveBeenCalledTimes(1)
    })

    it("is a no-op when the anvil is already registered", async () => {
      const ctx = fixtureContext({ clusterPath: dir, dataPath: Path.join(dir, "data") }),
        create = jest.spyOn(AnvilProcess, "create")
      jest
        .spyOn(ctx.processManager, "get")
        .mockReturnValue({} as Partial<AnvilProcess> as AnvilProcess)

      await Steps.processes.anvil.runStart(ctx, null, signal)

      expect(create).not.toHaveBeenCalled()
    })
  })
})
