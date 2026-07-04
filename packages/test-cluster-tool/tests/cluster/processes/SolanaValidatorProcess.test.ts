import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import {
  ProcessManager,
  SolanaValidatorProcess
} from "@wireio/test-cluster-tool/cluster/processes"
import { BindConfig } from "@wireio/test-cluster-tool/config"
import { Localhost } from "@wireio/test-cluster-tool/utils"

describe("SolanaValidatorProcess", () => {
  let dir: string
  let manager: ProcessManager
  beforeAll(() => {
    dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "solval-"))
    ProcessManager.setClusterPath(dir)
    manager = ProcessManager.get()
  })
  afterEach(async () => {
    await manager.stopAll()
    delete process.env[SolanaValidatorProcess.VerboseEnvironmentVariable]
  })
  afterAll(() => {
    Fs.rmSync(dir, { recursive: true, force: true })
  })

  it("builds the validator argv with --quiet by default + loopback URLs", async () => {
    const validator = await SolanaValidatorProcess.create(manager, {
      binary: "/bin/true"
    })
    expect(validator.args).toEqual(
      expect.arrayContaining(["--rpc-port", "--faucet-port", "--quiet"])
    )
    expect(validator.rpcUrl).toContain(Localhost)
    expect(validator.wsUrl).toMatch(/^ws:\/\//)
  })

  it("deploys programs via --bpf-program", async () => {
    const validator = await SolanaValidatorProcess.create(manager, {
      binary: "/bin/true",
      programs: [{ name: "opp", programId: "PID", soFile: "/tmp/opp.so" }]
    })
    expect(validator.args).toEqual(
      expect.arrayContaining(["--bpf-program", "PID", "/tmp/opp.so"])
    )
  })

  it("drops --quiet when the verbose env var is set", async () => {
    process.env[SolanaValidatorProcess.VerboseEnvironmentVariable] = "1"
    const validator = await SolanaValidatorProcess.create(manager, {
      binary: "/bin/true"
    })
    expect(validator.args).not.toContain("--quiet")
  })

  it("passes an explicit --dynamic-port-range window verbatim", async () => {
    const validator = await SolanaValidatorProcess.create(manager, {
      binary: "/bin/true",
      dynamicPortRange: { first: 13_100, last: 13_163 }
    })
    expect(validator.args).toEqual(
      expect.arrayContaining(["--dynamic-port-range", "13100-13163"])
    )
  })

  it("defaults --dynamic-port-range to a resolved full-width window", async () => {
    const validator = await SolanaValidatorProcess.create(manager, {
      binary: "/bin/true"
    })
    const index = validator.args.indexOf("--dynamic-port-range")
    expect(index).toBeGreaterThanOrEqual(0)
    const [first, last] = validator.args[index + 1].split("-").map(Number)
    expect(last - first + 1).toBe(BindConfig.SolanaDynamicPortRangeSize)
  })
})
