import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { ProcessManager, SolanaValidatorProcess } from "@wireio/cluster-tool/cluster/processes"
import { BindConfigProvider } from "@wireio/cluster-tool/config"
import { Localhost } from "@wireio/cluster-tool/utils"

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
  })
  afterAll(() => {
    Fs.rmSync(dir, { recursive: true, force: true })
  })

  it("builds the validator argv + loopback URLs, and NEVER passes --quiet", async () => {
    const validator = await SolanaValidatorProcess.create(manager, {
      binary: "/bin/true"
    })
    expect(validator.args).toEqual(expect.arrayContaining(["--rpc-port", "--faucet-port", "--gossip-port"]))
    // A silencing flag on a dev/test daemon hides the exact startup panic and
    // the program `msg!()` output you need when it fails — it is unconditional,
    // with no env var to re-enable it.
    expect(validator.args).not.toContain("--quiet")
    expect(validator.rpcUrl).toContain(Localhost)
    expect(validator.wsUrl).toMatch(/^ws:\/\//)
  })

  it("passes an explicit --gossip-port verbatim (agave 4.x fixed-default gossip)", async () => {
    const validator = await SolanaValidatorProcess.create(manager, {
      binary: "/bin/true",
      gossipPort: 14_700
    })
    expect(validator.args).toEqual(expect.arrayContaining(["--gossip-port", "14700"]))
  })

  it("startup failure surfaces the validator.log tail and the assigned-port holders", async () => {
    // agave's real error (panic text, the AddrInUse socket) lands in the
    // ledger's validator.log, not on stdio — the fail-fast error must carry
    // it, or a CI failure is undiagnosable (2026-07-15 gate: five instant
    // exit-101s whose reason never reached any surfaced log).
    const ledgerPath = Path.join(dir, "failing-ledger")
    Fs.mkdirSync(ledgerPath, { recursive: true })
    Fs.writeFileSync(
      Path.join(ledgerPath, "validator.log"),
      "boot line\nPANIC-MARKER: gossip_addr bind: Address already in use\n"
    )
    const validator = await SolanaValidatorProcess.create(manager, {
      binary: "/bin/false",
      ledgerPath,
      dynamicPortRange: await BindConfigProvider.findAvailableRange()
    })
    await expect(validator.start()).rejects.toThrow(
      /exited \(code 1\)[\s\S]*validator\.log tail[\s\S]*PANIC-MARKER: gossip_addr bind[\s\S]*sockets live on assigned ports/
    )
  })

  it("deploys programs via --bpf-program", async () => {
    const validator = await SolanaValidatorProcess.create(manager, {
      binary: "/bin/true",
      programs: [{ name: "opp", programId: "PID", soFile: "/tmp/opp.so" }]
    })
    expect(validator.args).toEqual(expect.arrayContaining(["--bpf-program", "PID", "/tmp/opp.so"]))
  })

  it("deploys upgradeable via --upgradeable-program when an upgradeAuthority is set", async () => {
    const validator = await SolanaValidatorProcess.create(manager, {
      binary: "/bin/true",
      programs: [
        {
          name: "opp",
          programId: "PID",
          soFile: "/tmp/opp.so",
          upgradeAuthority: "UPGKEY"
        }
      ]
    })
    // The upgradeable form (so a ProgramData account exists) REPLACES the
    // non-upgradeable --bpf-program form — the two are mutually exclusive.
    expect(validator.args).toEqual(expect.arrayContaining(["--upgradeable-program", "PID", "/tmp/opp.so", "UPGKEY"]))
    expect(validator.args).not.toContain("--bpf-program")
  })

  // Program `msg!()` output is gated by RUST_LOG, NOT by --quiet: agave's
  // default filter omits `stable_log` entirely, which is why dropping --quiet
  // alone still produced a validator.log with zero `Program log:` lines.
  it("pins the ADDITIVE program-log filter — agave's own targets are retained", () => {
    // Replacing (rather than extending) agave's default would silence the
    // panic/bind lines validatorLogTail() surfaces on a startup failure.
    expect(SolanaValidatorProcess.ProgramLogRustLog).toBe(
      "solana=info,agave=info,solana_runtime::message_processor::stable_log=debug"
    )
    expect(SolanaValidatorProcess.DefaultEnv).toEqual({
      [SolanaValidatorProcess.RustLogEnvVar]: SolanaValidatorProcess.ProgramLogRustLog
    })
  })

  // resolveEnv takes the inherited filter as a PARAMETER, so the decision is
  // testable without mutating this worker's environment.
  it("enables agave's program-log target when RUST_LOG is unset", () => {
    expect(SolanaValidatorProcess.resolveEnv(undefined)).toEqual(SolanaValidatorProcess.DefaultEnv)
  })

  it("defers to an explicit RUST_LOG from the environment", () => {
    expect(SolanaValidatorProcess.resolveEnv("warn")).toEqual({})
  })

  it("wires resolveEnv into the live process env getter", async () => {
    const validator = await SolanaValidatorProcess.create(manager, {
      binary: "/bin/true"
    })
    expect(validator.env).toEqual(SolanaValidatorProcess.resolveEnv(process.env[SolanaValidatorProcess.RustLogEnvVar]))
  })

  it("passes an explicit --dynamic-port-range window verbatim", async () => {
    const validator = await SolanaValidatorProcess.create(manager, {
      binary: "/bin/true",
      dynamicPortRange: { first: 13_100, last: 13_163 }
    })
    expect(validator.args).toEqual(expect.arrayContaining(["--dynamic-port-range", "13100-13163"]))
  })

  it("defaults --dynamic-port-range to a resolved full-width window", async () => {
    const validator = await SolanaValidatorProcess.create(manager, {
      binary: "/bin/true"
    })
    const index = validator.args.indexOf("--dynamic-port-range")
    expect(index).toBeGreaterThanOrEqual(0)
    const [first, last] = validator.args[index + 1].split("-").map(Number)
    expect(last - first + 1).toBe(BindConfigProvider.SolanaDynamicPortRangeSize)
  })

  it("defaults --limit-ledger-size to the full-run retention (agave's 10k-shred default prunes to ~90s)", async () => {
    const validator = await SolanaValidatorProcess.create(manager, {
      binary: "/bin/true"
    })
    expect(validator.args).toEqual(
      expect.arrayContaining(["--limit-ledger-size", String(SolanaValidatorProcess.DefaultLimitLedgerSizeShreds)])
    )
  })

  it("passes an explicit --limit-ledger-size verbatim", async () => {
    const validator = await SolanaValidatorProcess.create(manager, {
      binary: "/bin/true",
      limitLedgerSizeShreds: 250_000
    })
    expect(validator.args).toEqual(expect.arrayContaining(["--limit-ledger-size", "250000"]))
  })
})
