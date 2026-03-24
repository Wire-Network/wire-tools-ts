import path from "path"
import { ProcessManager, type ProcessConfig } from "./process-manager.js"
import { waitForEndpoint } from "../util.js"
import { log } from "../logger.js"

export interface SolanaValidatorConfig {
  /** RPC port (default: 8899) */
  rpcPort?: number
  /** Faucet port (default: 9900) */
  faucetPort?: number
  /** Ledger directory (default: temp dir) */
  ledgerDir?: string
  /** Path to solana-test-validator binary */
  binary?: string
  /** Programs to deploy on startup: [{name, programId, soFile}] */
  programs?: Array<{ name: string; programId: string; soFile: string }>
  /** Additional CLI flags */
  extraArgs?: string[]
}

/**
 * Manages a solana-test-validator (Agave) process.
 */
export class SolanaValidatorManager {
  private pm: ProcessManager
  private config: Required<Omit<SolanaValidatorConfig, "programs" | "extraArgs" | "ledgerDir">> &
    Pick<SolanaValidatorConfig, "programs" | "extraArgs" | "ledgerDir">

  constructor(pm: ProcessManager, config: SolanaValidatorConfig = {}) {
    this.pm = pm
    this.config = {
      rpcPort: config.rpcPort ?? 8899,
      faucetPort: config.faucetPort ?? 9900,
      binary: config.binary ??
        path.join(
          process.env.HOME || "~",
          ".local/share/solana/install/active_release/bin/solana-test-validator"
        ),
      ledgerDir: config.ledgerDir,
      programs: config.programs,
      extraArgs: config.extraArgs,
    }
  }

  get rpcUrl(): string {
    return `http://127.0.0.1:${this.config.rpcPort}`
  }

  get wsUrl(): string {
    return `ws://127.0.0.1:${this.config.rpcPort + 1}`
  }

  async start(): Promise<void> {
    const args = [
      "--rpc-port", String(this.config.rpcPort),
      "--faucet-port", String(this.config.faucetPort),
      "--quiet",
      "--reset",
    ]

    if (this.config.ledgerDir) {
      args.push("--ledger", this.config.ledgerDir)
    }

    for (const prog of this.config.programs || []) {
      args.push("--bpf-program", prog.programId, prog.soFile)
    }

    if (this.config.extraArgs) {
      args.push(...this.config.extraArgs)
    }

    const procConfig: ProcessConfig = {
      label: "solana-test-validator",
      command: this.config.binary,
      args,
    }

    await this.pm.spawn(procConfig)
    await waitForEndpoint(this.rpcUrl, { label: "solana-test-validator", timeoutMs: 30_000 })
    log.info(`Solana validator ready at ${this.rpcUrl}`)
  }

  async stop(): Promise<void> {
    const handle = this.pm.get("solana-test-validator")
    if (handle) await handle.kill()
  }
}
