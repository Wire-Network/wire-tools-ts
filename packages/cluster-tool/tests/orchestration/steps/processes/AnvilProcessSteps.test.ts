import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import {
  AnvilProcess,
  ProcessManager
} from "@wireio/cluster-tool/cluster/processes"
import { BindConfigProvider } from "@wireio/cluster-tool/config"
import { ClusterBuildContext, Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { fixtureContext } from "../../../config/clusterBuildContextFixture.js"
import { PersistedFixture } from "../../../config/clusterConfigFixture.js"

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
    /** A binary that exists, so `AnvilProcess.create` builds a real process; `start` is spied, so it never runs. */
    const StandInBinary = "/bin/true"
    const signal = new AbortController().signal,
      createAnvil = AnvilProcess.create.bind(AnvilProcess)
    let dir: string, anvilPort: number

    // ProcessManager is a set-once singleton: one sandbox for the whole block.
    beforeAll(async () => {
      dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "anvilsteps-"))
      ProcessManager.setClusterPath(dir)
      anvilPort = await BindConfigProvider.findAvailable(BindConfigProvider.DefaultAnvil)
    })
    afterEach(async () => {
      jest.restoreAllMocks()
      await ProcessManager.get().stopAll()
    })
    afterAll(() => {
      Fs.rmSync(dir, { recursive: true, force: true })
    })

    /** A context over the sandbox whose anvil binds the registry-issued port. */
    function sandboxContext(): ClusterBuildContext {
      return fixtureContext({
        clusterPath: dir,
        dataPath: Path.join(dir, "data"),
        bind: {
          ...PersistedFixture.bind,
          anvil: { ...PersistedFixture.bind.anvil, port: anvilPort }
        }
      })
    }

    it("spawns anvil with the finality window and without interval mining", async () => {
      const ctx = sandboxContext(),
        create = jest
          .spyOn(AnvilProcess, "create")
          .mockImplementation((manager, options) =>
            createAnvil(manager, { ...options, binary: StandInBinary })
          ),
        start = jest
          .spyOn(AnvilProcess.prototype, "start")
          .mockImplementation(function (this: AnvilProcess) {
            return Promise.resolve(this)
          })

      await Steps.processes.anvil.runStart(ctx, null, signal)

      expect(create).toHaveBeenCalledTimes(1)
      const [manager, options] = create.mock.calls[0]
      expect(manager).toBe(ctx.processManager)
      expect(options).toMatchObject({
        host: ctx.config.bind.anvil.address,
        port: anvilPort,
        chainId: AnvilProcess.DefaultChainId,
        slotsInAnEpoch: AnvilProcess.SlotsInAnEpoch
      })
      expect(options.blockTimeSec).toBeUndefined()
      expect(options).toEqual(AnvilProcess.optionsFor(ctx.config, AnvilProcess.Launch.deploy))
      expect(start).toHaveBeenCalledTimes(1)
    })

    it("is a no-op when the anvil is already registered", async () => {
      const ctx = sandboxContext()
      await createAnvil(ctx.processManager, { binary: StandInBinary })
      const create = jest.spyOn(AnvilProcess, "create")

      await Steps.processes.anvil.runStart(ctx, null, signal)

      expect(create).not.toHaveBeenCalled()
    })
  })
})
