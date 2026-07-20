import {
  BindConfigPortProtocol,
  type BindConfigPortRange
} from "@wireio/cluster-tool-shared"
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
import {
  filterSocketLinesByLocalPort,
  Localhost,
  toDialAddress,
  toURL,
  URLScheme
} from "../../utils/netUtils.js"
import { ManagedProcess } from "./ManagedProcess.js"
import type { ProcessManager } from "./ProcessManager.js"

/** A BPF program to deploy on validator startup. */
export interface SolanaValidatorProgram {
  name: string
  programId: string
  soFile: string
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
  static async create(
    manager: ProcessManager,
    options: SolanaValidatorOptions = {}
  ): Promise<SolanaValidatorProcess> {
    const { binary = await which("solana-test-validator") } = options
    Assert.ok(
      binary != null && (await existsAsync(binary)),
      "solana-test-validator binary not found on PATH"
    )
    const config: SolanaValidatorConfig = {
      address: options.address ?? Localhost,
      rpcPort:
        options.rpcPort ??
        (await BindConfigProvider.findAvailable(
          BindConfigProvider.DefaultSolanaRpc
        )),
      faucetPort:
        options.faucetPort ??
        (await BindConfigProvider.findAvailable(
          BindConfigProvider.DefaultSolanaFaucet
        )),
      gossipPort:
        options.gossipPort ??
        (await BindConfigProvider.findAvailable(
          BindConfigProvider.DefaultSolanaGossip,
          BindConfigPortProtocol.udp
        )),
      dynamicPortRange:
        options.dynamicPortRange ??
        (await BindConfigProvider.findAvailableRange()),
      ledgerPath: options.ledgerPath ?? null,
      limitLedgerSizeShreds:
        options.limitLedgerSizeShreds ??
        SolanaValidatorProcess.DefaultLimitLedgerSizeShreds,
      binary,
      programs: options.programs ?? [],
      extraArgs: options.extraArgs ?? []
    }
    return new SolanaValidatorProcess(manager, config)
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

  get args(): string[] {
    // `--quiet` suppresses program `msg!()` output; disable it (verbose) so
    // on-chain log lines land in the process log when debugging.
    const verbose =
      process.env[SolanaValidatorProcess.VerboseEnvironmentVariable] === "1"
    return [
      "--rpc-port",
      String(this.config.rpcPort),
      "--faucet-port",
      String(this.config.faucetPort),
      "--gossip-port",
      String(this.config.gossipPort),
      "--dynamic-port-range",
      `${this.config.dynamicPortRange.first}-${this.config.dynamicPortRange.last}`,
      "--limit-ledger-size",
      String(this.config.limitLedgerSizeShreds),
      ...(verbose ? [] : ["--quiet"]),
      ...(this.config.ledgerPath ? ["--ledger", this.config.ledgerPath] : []),
      ...this.config.programs.flatMap(program => [
        "--bpf-program",
        program.programId,
        program.soFile
      ]),
      ...this.config.extraArgs
    ]
  }

  protected get verifyTimeoutMs(): number {
    return SolanaValidatorProcess.StartupTimeoutMs
  }

  /** Ready only once the endpoint answers AND ≥1 slot has been produced (an
   *  airdrop before the first slot times out). */
  protected async verifyReady(): Promise<boolean> {
    if (!(await probeEndpoint(this.rpcUrl))) return false
    try {
      const slot = await new Connection(
        this.rpcUrl,
        SolanaClient.DefaultCommitment
      ).getSlot()
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
      ...range(
        this.config.dynamicPortRange.first,
        this.config.dynamicPortRange.last + 1
      )
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
    const parts = [this.validatorLogTail(), this.assignedPortHolders()].filter(
      part => !isEmpty(part)
    )
    return parts.length === 0 ? null : parts.join("\n")
  }

  /** Last {@link SolanaValidatorProcess.ValidatorLogTailLines} lines of the ledger's validator.log (null when unreadable). */
  private validatorLogTail(): string {
    if (this.config.ledgerPath == null) return null
    const logFile = Path.join(this.config.ledgerPath, "validator.log")
    return getValue(() => {
      const lines = Fs.readFileSync(logFile, "utf8").trimEnd().split("\n")
      const tail = lines
        .slice(-SolanaValidatorProcess.ValidatorLogTailLines)
        .join("\n")
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
  /** Env var that, when `"1"`, drops `--quiet` so program logs are captured. */
  export const VerboseEnvironmentVariable = "WIRE_SOLANA_VALIDATOR_VERBOSE"
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
