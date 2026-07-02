import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import {
  KiodProcess,
  ProcessManager
} from "@wireio/test-cluster-tool/cluster/processes"
import { Localhost } from "@wireio/test-cluster-tool/utils"

describe("KiodProcess", () => {
  let dir: string
  let manager: ProcessManager
  beforeAll(() => {
    dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "kiodproc-"))
    ProcessManager.setClusterPath(dir)
    manager = ProcessManager.get()
  })
  afterEach(async () => {
    await manager.stopAll()
  })
  afterAll(() => {
    Fs.rmSync(dir, { recursive: true, force: true })
  })

  it("requires a binary and a walletPath", async () => {
    await expect(KiodProcess.create(manager, {})).rejects.toThrow(/binary/)
    await expect(
      KiodProcess.create(manager, { binary: "/bin/true" })
    ).rejects.toThrow(/walletPath/)
  })

  it("builds the kiod argv, runs out of the wallet dir, dials loopback", async () => {
    const process = await KiodProcess.create(manager, {
      binary: "/bin/true",
      walletPath: dir
    })
    expect(process.exe).toBe("/bin/true")
    expect(process.cwd).toBe(dir)
    expect(process.args).toEqual(
      expect.arrayContaining(["--wallet-dir", dir, "--verbose-http-errors"])
    )
    expect(process.httpUrl).toContain(Localhost)
  })
})
