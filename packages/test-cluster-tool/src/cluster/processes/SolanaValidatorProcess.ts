import { Connection } from "@solana/web3.js"
import Assert from "node:assert"
import { SolanaClient } from "../../clients/solana/SolanaClient.js"
import { BindConfig, type BindConfigPortRange } from "../../config/BindConfig.js"
import { probeEndpoint } from "../../utils/asyncUtils.js"
import { existsAsync, which } from "../../utils/fsUtils.js"
import { Localhost, toURL } from "../../utils/netUtils.js"
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
  /** RPC port. Defaults to a free port preferring `DefaultRpcPort`. */
  rpcPort?: number
  /** Faucet port. Defaults to a free port preferring `DefaultFaucetPort`. */
  faucetPort?: number
  /**
   * `--dynamic-port-range` window for the validator's gossip/TPU/TVU sockets.
   * MUST be disjoint per concurrent validator: without it every instance
   * carves from the same agave default range, UDP-double-binds silently, and
   * forwarded transactions vanish into the co-runner's TPU (signatures
   * returned, never landed). Defaults to `BindConfig.findAvailableRange()`.
   */
  dynamicPortRange?: BindConfigPortRange
  /** Ledger directory (`--ledger`). */
  ledgerPath?: string | null
  /** Validator binary. Resolved from PATH when omitted. */
  binary?: string
  /** Programs to deploy on startup (`--bpf-program`). */
  programs?: SolanaValidatorProgram[]
  /** Additional CLI flags. */
  extraArgs?: string[]
}

/** Resolved validator config. */
export interface SolanaValidatorConfig
  extends Required<SolanaValidatorOptions> {}

/** Manages a solana-test-validator (Agave) process. */
export class SolanaValidatorProcess extends ManagedProcess {
  static async create(
    manager: ProcessManager,
    options: SolanaValidatorOptions = {}
  ): Promise<SolanaValidatorProcess> {
    const binary = options.binary ?? (await which("solana-test-validator"))
    Assert.ok(
      binary != null && (await existsAsync(binary)),
      "solana-test-validator binary not found on PATH"
    )
    const config: SolanaValidatorConfig = {
      rpcPort:
        options.rpcPort ??
        (await BindConfig.findAvailable(BindConfig.DefaultSolanaRpc)),
      faucetPort:
        options.faucetPort ??
        (await BindConfig.findAvailable(BindConfig.DefaultSolanaFaucet)),
      dynamicPortRange:
        options.dynamicPortRange ?? (await BindConfig.findAvailableRange()),
      ledgerPath: options.ledgerPath ?? null,
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
    const verbose = process.env[SolanaValidatorProcess.VerboseEnvironmentVariable] === "1"
    return [
      "--rpc-port",
      String(this.config.rpcPort),
      "--faucet-port",
      String(this.config.faucetPort),
      "--dynamic-port-range",
      `${this.config.dynamicPortRange.first}-${this.config.dynamicPortRange.last}`,
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

  get rpcUrl(): string {
    return toURL(this.config.rpcPort, Localhost)
  }

  get wsUrl(): string {
    return toURL(
      this.config.rpcPort + SolanaValidatorProcess.WsPortOffset,
      Localhost,
      "ws"
    )
  }
}

export namespace SolanaValidatorProcess {
  /** Offset added to `rpcPort` for the WebSocket port (Solana convention). */
  export const WsPortOffset = 1
  export const ProcessLabel = "solana-test-validator" as const
  export const SlotPollIntervalMs = 500
  export const StartupTimeoutMs = 30_000
  /** Env var that, when `"1"`, drops `--quiet` so program logs are captured. */
  export const VerboseEnvironmentVariable = "WIRE_SOLANA_VALIDATOR_VERBOSE"
}
