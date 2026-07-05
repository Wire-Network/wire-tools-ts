import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import {
  AnvilProcess,
  ProcessManager
} from "@wireio/cluster-tool/cluster/processes"
import { Localhost } from "@wireio/cluster-tool/utils"

describe("AnvilProcess", () => {
  let dir: string
  let manager: ProcessManager
  beforeAll(() => {
    dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "anvilproc-"))
    ProcessManager.setClusterPath(dir)
    manager = ProcessManager.get()
  })
  afterEach(async () => {
    await manager.stopAll()
  })
  afterAll(() => {
    Fs.rmSync(dir, { recursive: true, force: true })
  })

  it("builds the base anvil argv with host/port/chain-id", async () => {
    const process = await AnvilProcess.create(manager, { binary: "/bin/true" })
    expect(process.exe).toBe("/bin/true")
    expect(process.args).toEqual(
      expect.arrayContaining([
        "--host",
        "--port",
        "--chain-id",
        String(AnvilProcess.DefaultChainId)
      ])
    )
  })

  it("adds the run-phase finality flags only when set", async () => {
    const without = await AnvilProcess.create(manager, { binary: "/bin/true" })
    expect(without.args).not.toContain("--block-time")
    await manager.stopAll()

    const withFlags = await AnvilProcess.create(manager, {
      binary: "/bin/true",
      slotsInAnEpoch: AnvilProcess.SlotsInAnEpoch,
      blockTimeSec: AnvilProcess.BlockTimeSec
    })
    expect(withFlags.args).toEqual(
      expect.arrayContaining(["--slots-in-an-epoch", "--block-time"])
    )
  })

  it("dials loopback on the resolved (free) port", async () => {
    const process = await AnvilProcess.create(manager, { binary: "/bin/true" })
    expect(process.rpcUrl).toContain(Localhost)
    expect(process.rpcUrl).toMatch(/^http:\/\/.+:\d+$/)
  })
})
