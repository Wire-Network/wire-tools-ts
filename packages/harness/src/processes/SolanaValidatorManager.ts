import Path from "path"
import { Connection } from "@solana/web3.js"
import { ProcessManager, type ProcessConfig } from "./ProcessManager.js"
import { existsAsync, waitForEndpoint, sleep } from "../util.js"
import { log } from "../logger.js"
import { defaults } from "lodash"
import { which } from "zx"
import { asOption } from "@3fv/prelude-ts"
import { assert } from "@wireio/shared"

export interface SolanaValidatorOptions {
  /** RPC port (default: 8899) */
  rpcPort?: number
  /** Faucet port (default: 9900) */
  faucetPort?: number
  /** Ledger directory (optional) */
  ledgerPath?: string
  /** Path to solana-test-validator binary */
  binary?: string
  /** Programs to deploy on startup: [{name, programId, soFile}] */
  programs?: Array<{ name: string; programId: string; soFile: string }>
  /** Additional CLI flags */
  extraArgs?: string[]
}

export async function createSolanaValidatorDefaultOptions(): Promise<
  Partial<SolanaValidatorOptions>
> {
  return {
    rpcPort: SolanaValidatorManager.DefaultRpcPort,
    faucetPort: SolanaValidatorManager.DefaultFaucetPort,
    binary: asOption(await which("solana-test-validator")).getOrUndefined()
  }
}

export interface SolanaValidatorConfig extends Required<SolanaValidatorOptions> {}

/**
 * Manages a solana-test-validator (Agave) process.
 */
export class SolanaValidatorManager {
  static async create(options: SolanaValidatorOptions = {}) {
    const config = defaults(
      { ...options },
      await createSolanaValidatorDefaultOptions()
    ) as SolanaValidatorConfig
    assert(
      await existsAsync(config.binary),
      "solana-test-validator binary path is required"
    )
    return new SolanaValidatorManager(config)
  }

  private constructor(readonly config: SolanaValidatorConfig) {}

  get rpcUrl(): string {
    return `http://127.0.0.1:${this.config.rpcPort}`
  }

  get wsUrl(): string {
    return `ws://127.0.0.1:${this.config.rpcPort + 1}`
  }

  async start(): Promise<void> {
    const { config } = this
    const args = [
      "--rpc-port",
      String(config.rpcPort),
      "--faucet-port",
      String(config.faucetPort),
      "--quiet",
      "--reset"
    ]

    if (config.ledgerPath) {
      args.push("--ledger", config.ledgerPath)
    }

    for (const prog of config.programs || []) {
      args.push("--bpf-program", prog.programId, prog.soFile)
    }

    if (config.extraArgs) {
      args.push(...config.extraArgs)
    }

    const procConfig: ProcessConfig = {
      label: "solana-test-validator",
      command: config.binary,
      args
    }

    await ProcessManager.get().spawn(procConfig)
    await waitForEndpoint(this.rpcUrl, {
      label: "solana-test-validator",
      timeoutMs: SolanaValidatorManager.StartupTimeoutMs
    })

    // Wait for the validator to produce at least one slot. The RPC endpoint
    // answers GET with 404 immediately at startup, before the first block is
    // processed. Attempting an airdrop before any slots are produced causes
    // TransactionExpiredTimeoutError because the faucet's submitted txn never
    // lands in a confirmed block.
    const conn = new Connection(this.rpcUrl, "confirmed")
    const slotDeadline = Date.now() + SolanaValidatorManager.StartupTimeoutMs
    while (Date.now() < slotDeadline) {
      try {
        const slot = await conn.getSlot()
        if (slot > 0) break
      } catch {
        // RPC not fully up yet
      }
      await sleep(500)
    }

    log.info(`Solana validator ready at ${this.rpcUrl}`)
  }

  async stop(): Promise<void> {
    const handle = ProcessManager.get().get("solana-test-validator")
    if (handle) await handle.kill()
  }
}

export namespace SolanaValidatorManager {
  export const DefaultRpcPort = 8899
  export const DefaultFaucetPort = 9900

  /** Timeout for waiting on solana-test-validator startup (ms). */
  export const StartupTimeoutMs = 30_000
}
