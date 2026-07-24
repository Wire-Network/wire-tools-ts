import { DebuggingServer } from "@wireio/debugging-server"
import { Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { fixtureContext } from "../../../config/clusterBuildContextFixture.js"
import { PersistedFixture } from "../../../config/clusterConfigFixture.js"

describe("Steps.processes.debuggingServer", () => {
  it("start builds an input-less step with a runner", () => {
    const step = Steps.processes.debuggingServer.planStart(
      Report.Actor.Sysio,
      "start-debugging-server",
      "start the OPP debugging server",
      {}
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.input).toBeNull()
    expect(typeof step.runner).toBe("function")
  })

  it("runStart binds the CONFIGURED debuggingServer address, not the 127.0.0.1 default", async () => {
    // A non-loopback address so a pass-through of the config (the fix) is
    // distinguishable from the hardcoded 127.0.0.1 default (the bug).
    const host = "192.168.50.7"
    const ctx = fixtureContext({
      bind: {
        ...PersistedFixture.bind,
        debuggingServer: {
          address: host,
          port: PersistedFixture.bind.debuggingServer.port
        }
      }
    })
    const fakeServer = {
      start: async () => ({
        address: host,
        port: ctx.config.bind.debuggingServer.port,
        family: "IPv4"
      })
    }
    const createSpy = jest
      .spyOn(DebuggingServer, "create")
      .mockResolvedValue(fakeServer as unknown as DebuggingServer)
    try {
      await Steps.processes.debuggingServer.runStart(
        ctx,
        null,
        new AbortController().signal
      )
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          host,
          port: ctx.config.bind.debuggingServer.port,
          clusterPath: ctx.config.clusterPath
        })
      )
    } finally {
      createSpy.mockRestore()
    }
  })
})
