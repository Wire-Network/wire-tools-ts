import ChildProcess from "node:child_process"
import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"

import {
  ManagedProcess,
  ProcessManager,
  SolanaValidatorProcess
} from "@wireio/cluster-tool/cluster/processes"
import { BindConfigProvider } from "@wireio/cluster-tool/config"

describe("Solana validator bind failure diagnostics", () => {
  let clusterPath: string,
    manager: ProcessManager,
    ledgerPath: string,
    logFile: string,
    validator: SolanaValidatorProcess,
    observe: (current: Fs.Stats, previous: Fs.Stats) => void

  beforeAll(() => {
    clusterPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), "solana-bind-failure-"))
    manager = ProcessManager.setClusterPath(clusterPath).get()
  })
  beforeEach(async () => {
    ledgerPath = Fs.mkdtempSync(Path.join(clusterPath, "ledger-"))
    logFile = Path.join(ledgerPath, "validator.log")
    const bind = await BindConfigProvider.resolve(
      {},
      { producerCount: 0, batchOperatorCount: 0 }
    )
    validator = await SolanaValidatorProcess.create(manager, {
      binary: "/bin/false",
      ledgerPath,
      rpcPort: bind.solana.ports.http,
      faucetPort: bind.solana.ports.faucet,
      gossipPort: bind.solana.ports.gossip,
      dynamicPortRange: bind.solana.ports.dynamicRange
    })
    jest
      .spyOn(Fs, "watchFile")
      .mockImplementation(
        (file, listenerOrOptions, listener?: typeof observe) => {
          observe = listener ?? listenerOrOptions
          return null
        }
      )
    jest.spyOn(Fs, "unwatchFile").mockImplementation(() => null)
  })
  afterEach(async () => {
    jest.restoreAllMocks()
    await manager.stopAll()
  })
  afterAll(() => Fs.rmSync(clusterPath, { recursive: true, force: true }))

  it("captures connected socket owners on the first bind error and retains them after the holder disappears", async () => {
    const holder = `tcp ESTAB 0 0 127.0.0.1:${Number(new URL(validator.wsUrl).port)} 127.0.0.1:${Number(new URL(validator.rpcUrl).port)} users:(("short-lived-client",pid=123,fd=4))`,
      snapshot = jest
        .spyOn(ChildProcess, "execFileSync")
        .mockReturnValue(holder),
      raw = jest.spyOn(manager, "writeRaw").mockImplementation(() => null),
      start = ManagedProcess.prototype.start
    Fs.writeFileSync(logFile, "old log content\n")
    jest
      .spyOn(ManagedProcess.prototype, "start")
      .mockImplementation(async function () {
        const previous = Fs.statSync(logFile)
        Fs.appendFileSync(
          logFile,
          "failed to bind rpc_pubsub listener: Address already in use\n"
        )
        observe(Fs.statSync(logFile), previous)
        snapshot.mockReturnValue("")
        Fs.appendFileSync(logFile, "still producing slots\n")
        observe(Fs.statSync(logFile), previous)
        return start.call(this)
      })
    await expect(validator.start()).rejects.toThrow(
      /bind failure observed at[\s\S]*short-lived-client[\s\S]*sockets live on assigned ports[\s\S]*none visible/
    )
    expect(snapshot).toHaveBeenCalledTimes(2)
    expect(snapshot).toHaveBeenCalledWith(
      "ss",
      ["-tuapn"],
      expect.objectContaining({
        timeout: SolanaValidatorProcess.SocketSnapshotTimeoutMs
      })
    )
    expect(raw).toHaveBeenCalledWith(
      validator.label,
      expect.stringMatching(/bind failure observed at[\s\S]*short-lived-client/)
    )
    expect(Fs.unwatchFile).toHaveBeenCalledWith(logFile, observe)
  })

  it("handles log creation, split error writes, and always removes the watcher on failed startup", async () => {
    const raw = jest.spyOn(manager, "writeRaw").mockImplementation(() => null)
    jest.spyOn(ChildProcess, "execFileSync").mockReturnValue("")
    jest
      .spyOn(ManagedProcess.prototype, "start")
      .mockImplementation(async () => {
        Fs.writeFileSync(logFile, "failed to ")
        const previous = Fs.statSync(logFile)
        observe(previous, previous)
        Fs.appendFileSync(logFile, "bind rpc_pubsub listener\n")
        observe(Fs.statSync(logFile), previous)
        throw new Error("startup failed")
      })
    await expect(validator.start()).rejects.toThrow("startup failed")
    expect(raw).toHaveBeenCalledWith(
      validator.label,
      expect.stringContaining("bind failure observed at")
    )
    expect(Fs.unwatchFile).toHaveBeenCalledWith(logFile, observe)
  })

  it("ignores stale log errors and observes a replacement log from its beginning", async () => {
    Fs.writeFileSync(logFile, "Address already in use\n")
    const raw = jest.spyOn(manager, "writeRaw").mockImplementation(() => null)
    jest.spyOn(ChildProcess, "execFileSync").mockReturnValue("")
    jest
      .spyOn(ManagedProcess.prototype, "start")
      .mockImplementation(async function () {
        const previous = Fs.statSync(logFile)
        observe(previous, previous)
        expect(raw).not.toHaveBeenCalled()
        Fs.renameSync(logFile, `${logFile}.old`)
        Fs.writeFileSync(logFile, "AddrInUse\n")
        observe(Fs.statSync(logFile), previous)
        return this
      })
    await validator.start()
    expect(raw).toHaveBeenCalledTimes(1)
  })

  it("tolerates missing log files and unavailable socket diagnostics", async () => {
    const raw = jest.spyOn(manager, "writeRaw").mockImplementation(() => null)
    jest.spyOn(ChildProcess, "execFileSync").mockImplementation(() => {
      throw new Error("ss unavailable")
    })
    jest
      .spyOn(ManagedProcess.prototype, "start")
      .mockImplementation(async function () {
        Fs.writeFileSync(logFile, "booting\n")
        const previous = Fs.statSync(logFile)
        Fs.renameSync(logFile, `${logFile}.old`)
        observe(previous, previous)
        Fs.writeFileSync(logFile, "Address already in use\n")
        observe(Fs.statSync(logFile), previous)
        return this
      })
    await validator.start()
    expect(raw).toHaveBeenCalledWith(
      validator.label,
      expect.stringContaining("socket ownership unavailable")
    )
  })
})
