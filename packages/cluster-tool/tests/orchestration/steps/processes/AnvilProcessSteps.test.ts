import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"

import {
  AnvilProcess,
  ProcessManager
} from "@wireio/cluster-tool/cluster/processes"
import { BindConfigProvider } from "@wireio/cluster-tool/config"
import { Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"

import { fixtureContext } from "../../../config/clusterBuildContextFixture.js"
import { PersistedFixture } from "../../../config/clusterConfigFixture.js"

describe("Steps.processes.anvil", () => {
  let directory: string
  let context: ReturnType<typeof fixtureContext>

  beforeAll(() => {
    directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), "anvil-steps-"))
    ProcessManager.setClusterPath(directory)
  })

  beforeEach(async () => {
    const port = await BindConfigProvider.findAvailable(
        BindConfigProvider.DefaultAnvil
      ),
      create = AnvilProcess.create
    context = fixtureContext({
      clusterPath: directory,
      dataPath: Path.join(directory, "data"),
      bind: {
        ...PersistedFixture.bind,
        anvil: { ...PersistedFixture.bind.anvil, port }
      }
    })
    jest.spyOn(AnvilProcess, "create").mockImplementation((manager, options) =>
      create(manager, { ...options, binary: "/bin/true" })
    )
    jest.spyOn(AnvilProcess.prototype, "start").mockImplementation(async function () {
      return this
    })
  })

  afterEach(async () => {
    await ProcessManager.get().stopAll()
    jest.restoreAllMocks()
  })

  afterAll(() => {
    Fs.rmSync(directory, { recursive: true, force: true })
  })

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

  it("starts with the cluster finality lag while preserving deploy instamine", async () => {
    await Steps.processes.anvil.runStart(context, null, new AbortController().signal)
    const process = context.processManager.get(AnvilProcess.ProcessLabel),
      args = process.args
    expect(args).toContain("--slots-in-an-epoch")
    expect(args[args.indexOf("--slots-in-an-epoch") + 1]).toBe(
      String(AnvilProcess.SlotsInAnEpoch)
    )
    expect(args).not.toContain("--block-time")
    expect(AnvilProcess.prototype.start).toHaveBeenCalledTimes(1)
  })

  it("does not recreate an existing anvil", async () => {
    const signal = new AbortController().signal
    await Steps.processes.anvil.runStart(context, null, signal)
    await Steps.processes.anvil.runStart(context, null, signal)
    expect(AnvilProcess.create).toHaveBeenCalledTimes(1)
    expect(AnvilProcess.prototype.start).toHaveBeenCalledTimes(1)
  })

  it("does not create an anvil when startup is aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      Steps.processes.anvil.runStart(context, null, controller.signal)
    ).rejects.toThrow()
    expect(AnvilProcess.create).not.toHaveBeenCalled()
  })
})
