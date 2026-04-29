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
    return `http://${SolanaValidatorManager.DefaultHost}:${this.config.rpcPort}`
  }

  get wsUrl(): string {
    return `ws://${SolanaValidatorManager.DefaultHost}:${this.config.rpcPort + SolanaValidatorManager.WsPortOffset}`
  }

  async start(): Promise<void> {
    const { config } = this
    const args = [
      "--rpc-port",
      String(config.rpcPort),
      "--faucet-port",
      String(config.faucetPort),
      "--quiet",
      ...(config.ledgerPath ? ["--ledger", config.ledgerPath] : []),
      ...(config.programs ?? []).flatMap(prog => [
        "--bpf-program",
        prog.programId,
        prog.soFile
      ]),
      ...(config.extraArgs ?? [])
    ]

    const procConfig: ProcessConfig = {
      label: SolanaValidatorManager.ProcessLabel,
      command: config.binary,
      args
    }

    await ProcessManager.get().spawn(procConfig)
    await waitForEndpoint(this.rpcUrl, {
      label: SolanaValidatorManager.ProcessLabel,
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
      await sleep(SolanaValidatorManager.SlotPollIntervalMs)
    }

    log.info(`Solana validator ready at ${this.rpcUrl}`)
  }

  async stop(): Promise<void> {
    const handle = ProcessManager.get().get(SolanaValidatorManager.ProcessLabel)
    if (handle) await handle.kill()
  }
}

export namespace SolanaValidatorManager {
  /** Loopback host the validator binds to. */
  export const DefaultHost = "127.0.0.1"
  /** Default JSON-RPC HTTP port. */
  export const DefaultRpcPort = 8899
  /** Default faucet port. */
  export const DefaultFaucetPort = 9900
  /** Offset added to `rpcPort` to derive the WebSocket port (Solana convention). */
  export const WsPortOffset = 1
  /** Process-manager label — pid file basename + log prefix. */
  export const ProcessLabel = "solana-test-validator" as const
  /** Polling interval while waiting for the validator's first slot. */
  export const SlotPollIntervalMs = 500
  /** Timeout for waiting on solana-test-validator startup (ms). */
  export const StartupTimeoutMs = 30_000
}
