import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { PublicKey } from "@solana/web3.js"
import { OppSolProgram, Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"

describe("Steps.processes.solanaValidator", () => {
  it("start builds an input-less step with a runner", () => {
    const step = Steps.processes.solanaValidator.planStart(
      Report.Actor.SolanaOutpost,
      "start-validator",
      "start solana-test-validator + liqsol_core (OPP outpost)",
      {}
    )
    expect(step.actor).toBe(Report.Actor.SolanaOutpost)
    expect(step.input).toBeNull()
    expect(typeof step.runner).toBe("function")
  })
})

describe("Steps.processes.solanaValidator.solanaWarpArgs", () => {
  it("emits the OppSolProgram warp slot pair when warp is ON", () => {
    expect(Steps.processes.solanaValidator.solanaWarpArgs(true)).toEqual([
      "--slots-per-epoch",
      OppSolProgram.solanaWarpSlotsPerEpoch,
      "--warp-slot",
      OppSolProgram.solanaWarpSlot
    ])
  })

  it("emits NO args when warp is OFF (every flow but yield-distribution)", () => {
    expect(Steps.processes.solanaValidator.solanaWarpArgs(false)).toEqual([])
  })
})

describe("Steps.processes.solanaValidator.resolveUpgradeAuthority", () => {
  let dir: string
  beforeEach(() => {
    dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "solval-steps-"))
  })
  afterEach(() => {
    Fs.rmSync(dir, { recursive: true, force: true })
  })

  it("creates the deployer keypair on first call and returns a valid base58 pubkey", () => {
    const deployerFile = Path.join(dir, "nested", "sol-deployer-keypair.json")
    expect(Fs.existsSync(deployerFile)).toBe(false)
    const pubkey =
      Steps.processes.solanaValidator.resolveUpgradeAuthority(deployerFile)
    // The parent dir is created and the keypair persisted...
    expect(Fs.existsSync(deployerFile)).toBe(true)
    // ...and the returned value is a well-formed 32-byte base58 key.
    expect(() => new PublicKey(pubkey)).not.toThrow()
  })

  it("is idempotent — a second call reads the persisted key and returns the SAME pubkey", () => {
    const deployerFile = Path.join(dir, "sol-deployer-keypair.json")
    const first =
      Steps.processes.solanaValidator.resolveUpgradeAuthority(deployerFile)
    const second =
      Steps.processes.solanaValidator.resolveUpgradeAuthority(deployerFile)
    expect(second).toBe(first)
  })
})
