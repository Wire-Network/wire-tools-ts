import { BindConfigPortProtocol, type BindConfigPortRange } from "@wireio/cluster-tool-shared"
import { Connection } from "@solana/web3.js"
import Assert from "node:assert"
import { execFileSync } from "node:child_process"
import Fs from "node:fs"
import Path from "node:path"
import { isEmpty, range } from "lodash"
import { getValue } from "@wireio/shared"
import { SolanaClient } from "../../clients/solana/SolanaClient.js"
import { BindConfigProvider } from "../../config/BindConfigProvider.js"
import { probeEndpoint } from "../../utils/asyncUtils.js"
import { existsAsync, which } from "../../utils/fsUtils.js"
import { filterSocketLinesByLocalPort, Localhost, toDialAddress, toURL, URLScheme } from "../../utils/netUtils.js"
import { ManagedProcess } from "./ManagedProcess.js"
import type { ProcessManager } from "./ProcessManager.js"

/** A BPF program to deploy on validator startup. */
export interface SolanaValidatorProgram {
  name: string
  programId: string
  soFile: string
  /**
   * When set, the program is added to genesis as an UPGRADEABLE program
   * (`--upgradeable-program … <upgradeAuthority>`) so a `ProgramData` account
   * exists with this pubkey as its upgrade authority — required by the
   * integrated liqsol `initialize_global_config`. When omitted, the program is
   * loaded non-upgradeable (`--bpf-program`).
   */
  upgradeAuthority?: string
}

/** Caller options for the solana-test-validator. */
export interface SolanaValidatorOptions {
  /** Dial address (from `bind.solana.address`). Defaults to loopback. */
  address?: string
  /** RPC port. Defaults to a free port preferring `DefaultRpcPort`. */
  rpcPort?: number
  /** Faucet port. Defaults to a free port preferring `DefaultFaucetPort`. */
  faucetPort?: number
  /**
   * `--gossip-port`. agave 4.x binds gossip at its FIXED default (8000)
   * instead of carving it from `--dynamic-port-range`, so a second concurrent
   * validator panics with `Address already in use` unless each instance gets
   * its own resolved port. Defaults to a free port preferring
   * `BindConfigProvider.DefaultSolanaGossip`.
   */
  gossipPort?: number
  /**
   * `--dynamic-port-range` window for the validator's gossip/TPU/TVU sockets.
   * MUST be disjoint per concurrent validator: without it every instance
   * carves from the same agave default range, UDP-double-binds silently, and
   * forwarded transactions vanish into the co-runner's TPU (signatures
   * returned, never landed). Defaults to `BindConfigProvider.findAvailableRange()`.
   */
  dynamicPortRange?: BindConfigPortRange
  /** Ledger directory (`--ledger`). */
  ledgerPath?: string | null
  /**
   * `--limit-ledger-size` (shreds retained in root slots). agave's default is
   * a mere 10 000 shreds — the blockstore prunes to a ~90-second window, after
   * which `getSignaturesForAddress` / `getTransaction` history evaporates and
   * any consumer that scans it (the underwriter's SwapDeposit source-deposit
   * verify, forensic replay) hard-fails on transactions older than that.
   * Defaults to `DefaultLimitLedgerSizeShreds`, which retains a full flow
   * run's history (the cap bounds disk only when traffic actually reaches it).
   */
  limitLedgerSizeShreds?: number
  /** Validator binary. Resolved from PATH when omitted. */
  binary?: string
  /** Programs to deploy on startup (`--bpf-program`). */
  programs?: SolanaValidatorProgram[]
  /** Additional CLI flags. */
  extraArgs?: string[]
}

/** Resolved validator config. */
export interface SolanaValidatorConfig extends Required<SolanaValidatorOptions> {}

/** Manages a solana-test-validator (Agave) process. */
export class SolanaValidatorProcess extends ManagedProcess {
  static async create(manager: ProcessManager, options: SolanaValidatorOptions = {}): Promise<SolanaValidatorProcess> {
    const { binary = await which("solana-test-validator") } = options
    Assert.ok(binary != null && (await existsAsync(binary)), "solana-test-validator binary not found on PATH")
    return new SolanaValidatorProcess(
      manager,
      SolanaValidatorProcess.resolveConfig(options, {
        binary,
        rpcPort: options.rpcPort ?? (await BindConfigProvider.findAvailable(BindConfigProvider.DefaultSolanaRpc)),
        faucetPort:
          options.faucetPort ?? (await BindConfigProvider.findAvailable(BindConfigProvider.DefaultSolanaFaucet)),
        gossipPort:
          options.gossipPort ??
          (await BindConfigProvider.findAvailable(BindConfigProvider.DefaultSolanaGossip, BindConfigPortProtocol.udp)),
        dynamicPortRange: options.dynamicPortRange ?? (await BindConfigProvider.findAvailableRange())
      })
    )
  }

  private constructor(
    manager: ProcessManager,
    private readonly config: SolanaValidatorConfig
  ) {
    super(manager, {
      label: SolanaValidatorProcess.ProcessLabel,
      kind: ManagedProcess.Kind.solanaValidator
    })
  }

  get exe(): string {
    return this.config.binary
  }

  /**
   * Enable agave's program-log target so on-chain `msg!()` output reaches
   * `<ledger>/validator.log`.
   *
   * `--quiet` does NOT control this — it only trims console progress output.
   * Program logs are emitted by `solana_runtime::message_processor::stable_log`
   * at DEBUG, and agave's default filter omits that target entirely, so the
   * flag alone yields a 108MB validator.log containing zero `Program log:`
   * lines (verified on e2e run 31103866070).
   *
   * This matters because an OPP handler's log-and-skip is a SUCCESSFUL
   * transaction: nothing surfaces it as an error, and its `msg!()` reason is
   * the only record of which precondition failed. Scoped to the one target so
   * the log does not balloon with unrelated debug traffic, and only when the
   * caller has not already pinned `RUST_LOG`.
   */
  get env(): Record<string, string> {
    return SolanaValidatorProcess.resolveEnv()
  }

  get args(): string[] {
    return SolanaValidatorProcess.buildArgs(this.config)
  }

  protected get verifyTimeoutMs(): number {
    return SolanaValidatorProcess.StartupTimeoutMs
  }

  /** Ready only once the endpoint answers AND ≥1 slot has been produced (an
   *  airdrop before the first slot times out). */
  async verifyReady(): Promise<boolean> {
    if (!(await probeEndpoint(this.rpcUrl))) return false
    try {
      const slot = await new Connection(this.rpcUrl, SolanaClient.DefaultCommitment).getSlot()
      return slot > 0
    } catch {
      return false
    }
  }

  /** Every port this validator's config commits to binding. */
  private get assignedPorts(): Set<number> {
    return new Set([
      this.config.rpcPort,
      this.config.rpcPort + BindConfigProvider.SolanaWsPortOffset,
      this.config.faucetPort,
      this.config.gossipPort,
      ...range(this.config.dynamicPortRange.first, this.config.dynamicPortRange.last + 1)
    ])
  }

  /**
   * Startup-failure context: agave writes its real error (panic message, the
   * exact socket of an `AddrInUse`) to `<ledger>/validator.log`, NOT to the
   * captured stdio — the console shows only `Initializing...` before an
   * instant exit. Also names whoever currently holds one of this validator's
   * assigned ports (`ss -tuapn`), since a bind conflict's root cause is the
   * HOLDER, which is gone from every log by teardown time.
   */
  protected async startupFailureDetail(): Promise<string> {
    const parts = [this.validatorLogTail(), this.assignedPortHolders()].filter(part => !isEmpty(part))
    return parts.length === 0 ? null : parts.join("\n")
  }

  /** Last {@link SolanaValidatorProcess.ValidatorLogTailLines} lines of the ledger's validator.log (null when unreadable). */
  private validatorLogTail(): string {
    if (this.config.ledgerPath == null) return null
    const logFile = Path.join(this.config.ledgerPath, "validator.log")
    return getValue(() => {
      const lines = Fs.readFileSync(logFile, "utf8").trimEnd().split("\n")
      const tail = lines.slice(-SolanaValidatorProcess.ValidatorLogTailLines).join("\n")
      return `validator.log tail (${logFile}):\n${tail}`
    }, null)
  }

  /** Live sockets on this validator's assigned ports per `ss -tuapn` (null when `ss` is unavailable). */
  private assignedPortHolders(): string {
    return getValue(() => {
      const sockets = filterSocketLinesByLocalPort(
        execFileSync("ss", ["-tuapn"], { encoding: "utf8" }),
        this.assignedPorts
      )
      return `sockets live on assigned ports (ss -tuapn):\n${
        sockets.length > 0 ? sockets.join("\n") : "(none visible)"
      }`
    }, null)
  }

  get rpcUrl(): string {
    return toURL(this.config.rpcPort, toDialAddress(this.config.address))
  }

  get wsUrl(): string {
    return toURL(
      this.config.rpcPort + BindConfigProvider.SolanaWsPortOffset,
      toDialAddress(this.config.address),
      URLScheme.ws
    )
  }
}

export namespace SolanaValidatorProcess {
  /**
   * Resolve caller options into a complete {@link SolanaValidatorConfig}. PURE —
   * the PATH-resolved binary and every registry-issued port/range are INJECTED,
   * so a `start.sh` render rebuilds the same config without claiming a second
   * set of ports.
   *
   * The `programs` entries (programId / soFile / upgradeAuthority) are already
   * caller-supplied: the step that plans this validator resolves them from the
   * wire-solana tree and the cluster's deployer keypair, so they arrive here as
   * data rather than being probed.
   *
   * @param options - Caller overrides.
   * @param resolved - The impure values `create` obtained.
   * @returns The complete config.
   */
  /** The impure values `create` resolves (PATH lookup + registry-issued ports/range). */
  export interface ResolvedInputs {
    binary: string
    rpcPort: number
    faucetPort: number
    gossipPort: number
    dynamicPortRange: BindConfigPortRange
  }

  export function resolveConfig(options: SolanaValidatorOptions, resolved: ResolvedInputs): SolanaValidatorConfig {
    return {
      address: options.address ?? Localhost,
      rpcPort: resolved.rpcPort,
      faucetPort: resolved.faucetPort,
      gossipPort: resolved.gossipPort,
      dynamicPortRange: resolved.dynamicPortRange,
      ledgerPath: options.ledgerPath ?? null,
      limitLedgerSizeShreds: options.limitLedgerSizeShreds ?? SolanaValidatorProcess.DefaultLimitLedgerSizeShreds,
      binary: resolved.binary,
      programs: options.programs ?? [],
      extraArgs: options.extraArgs ?? []
    }
  }

  /**
   * The validator argv (WITHOUT the binary) — the ONE argv source, shared by the
   * live process and the `start.sh` renderer.
   *
   * NEVER emits `--quiet` (or any diagnostics-suppressing flag): a silenced
   * dev/test daemon hides the program `msg!()` output and the startup panic you
   * need the moment it fails.
   *
   * @param config - A resolved validator config.
   * @returns The argv.
   */
  export function buildArgs(config: SolanaValidatorConfig): string[] {
    return [
      "--rpc-port",
      String(config.rpcPort),
      "--faucet-port",
      String(config.faucetPort),
      "--gossip-port",
      String(config.gossipPort),
      "--dynamic-port-range",
      `${config.dynamicPortRange.first}-${config.dynamicPortRange.last}`,
      "--limit-ledger-size",
      String(config.limitLedgerSizeShreds),
      ...(config.ledgerPath ? ["--ledger", config.ledgerPath] : []),
      ...config.programs.flatMap(program =>
        program.upgradeAuthority
          ? ["--upgradeable-program", program.programId, program.soFile, program.upgradeAuthority]
          : ["--bpf-program", program.programId, program.soFile]
      ),
      ...config.extraArgs
    ]
  }

  export const ProcessLabel = "solana-test-validator" as const
  export const SlotPollIntervalMs = 500
  /**
   * Verify-ready ceiling. Loaded-host worst case, NOT the healthy-host
   * typical (~15s): the e2e gate bootstraps several clusters concurrently
   * (FLOW_MAX_CONCURRENCY), and simultaneous agave genesis creation + PoH
   * initialization on a shared runner blew past the previous 180s ceiling
   * (2026-07-14 gate run, concurrency 4). The readiness poll returns the
   * moment the validator answers + produces a slot, so a healthy host never
   * pays this ceiling.
   */
  export const StartupTimeoutMs = 480_000
  /** Harness-recognized env var controlling Rust validator log filters. */
  export const RustLogEnvVar = "RUST_LOG"
  /**
   * Additive `RUST_LOG` filter retaining agave's normal `solana=info` and
   * `agave=info` targets while enabling the specific program-log target, so
   * on-chain `msg!()` lines land in `<ledger>/validator.log`. Keeping the
   * defaults is load-bearing for startup-failure diagnosability: replacing
   * them would silence the panic and bind-error lines surfaced by
   * `validatorLogTail()`. The longest-prefix-specific DEBUG directive still
   * wins without enabling unrelated debug traffic.
   *
   * This is the DEFAULT, never a hard override: an operator-set
   * {@link RustLogEnvVar} wins on both start paths — {@link resolveEnv} defers
   * to it when the harness spawns the validator, and the emitted `start.sh`
   * renders it as a `${NAME:-default}` expansion evaluated at RUN time.
   */
  export const ProgramLogRustLog = "solana=info,agave=info,solana_runtime::message_processor::stable_log=debug"
  /**
   * The validator's default extra environment — HOST-INDEPENDENT, so it is safe
   * to freeze into a rendered `start.sh` at create time. {@link resolveEnv} is
   * the live-spawn counterpart; it reads the ambient environment and must NEVER
   * be used to populate {@link DaemonConfig.env}, whose value is serialized.
   */
  export const DefaultEnv: Readonly<Record<string, string>> = {
    [RustLogEnvVar]: ProgramLogRustLog
  }
  /**
   * Resolve the validator's extra spawn environment while preserving an
   * operator-provided {@link RustLogEnvVar}.
   *
   * @param rustLog - The inherited operator-provided filter, when present.
   * @returns Extra variables to merge over that environment.
   */
  export function resolveEnv(rustLog = process.env[RustLogEnvVar]): Record<string, string> {
    return rustLog ? {} : { ...DefaultEnv }
  }
  /**
   * Lines of `<ledger>/validator.log` surfaced in a startup-failure error —
   * agave's panic/bind-error detail lands there, not on the captured stdio.
   */
  export const ValidatorLogTailLines = 40
  /**
   * Default `--limit-ledger-size` (shreds) = agave-validator's MAINNET
   * default (`DEFAULT_MAX_LEDGER_SHREDS`), the value a real operator gets
   * when enabling the flag. solana-test-validator's own default is a mere
   * 10 000 shreds — the blockstore prunes to a ~90-second window, which
   * breaks every history-scanning consumer mid-flow (canonically: the
   * underwriter's SwapDeposit source-deposit verify walking
   * `getSignaturesForAddress`). The cap only bounds disk when actual
   * traffic reaches it; lowering it re-introduces mid-run history loss.
   */
  export const DefaultLimitLedgerSizeShreds = 200_000_000
  /** Subpath (under the cluster data dir) for the validator ledger. */
  export const LedgerSubpath = "solana-ledger"
}
