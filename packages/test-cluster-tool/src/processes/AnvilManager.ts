import Fs from "fs"
import { ProcessManager, type ProcessConfig } from "./ProcessManager.js"
import { existsAsync, waitForEndpoint } from "../util.js"
import { log } from "../logger.js"
import { defaults } from "lodash"
import { which } from "zx"
import { asOption } from "@3fv/prelude-ts"
import { assert } from "@wireio/shared"

export interface AnvilOptions {
  /** Host to bind (default: 127.0.0.1) */
  host?: string
  /** Port (default: 8545) */
  port?: number
  /** Chain ID (default: 31337) */
  chainId?: number
  /** State file path for persistence (optional) */
  stateFile?: string
  /** Path to anvil binary (default: "anvil") */
  binary?: string
  /** Additional CLI flags */
  extraArgs?: string[]
}

export async function createAnvilDefaultOptions(): Promise<
  Partial<AnvilOptions>
> {
  return {
    host: AnvilManager.DefaultHost,
    port: AnvilManager.DefaultPort,
    chainId: AnvilManager.DefaultChainId,
    binary: asOption(await which("anvil")).getOrUndefined()
  }
}

export interface AnvilConfig extends Required<AnvilOptions> {}

/**
 * Manages an anvil (Foundry) local Ethereum node process.
 */
export class AnvilManager {
  static async create(options: AnvilOptions = {}) {
    const config = defaults(
      { ...options },
      await createAnvilDefaultOptions()
    ) as AnvilConfig
    // DOUBLE CHECK CONFIG
    assert(await existsAsync(config.binary), "anvil binary path is required")
    return new AnvilManager(config)
  }

  private constructor(readonly config: AnvilConfig) {}

  get rpcUrl(): string {
    return `http://${this.config.host}:${this.config.port}`
  }

  async start(): Promise<void> {
    const { config } = this
    const args = [
      "-vvv",
      "--host",
      config.host,
      "--port",
      String(config.port),
      "--chain-id",
      String(config.chainId)
    ]
    if (config.stateFile) {
      args.push("--dump-state", config.stateFile)
      // Only load state if the file already exists (not first run)
      if (Fs.existsSync(config.stateFile)) {
        args.push("--load-state", config.stateFile)
      }
    }
    if (config.extraArgs) {
      args.push(...config.extraArgs)
    }

    const procConfig: ProcessConfig = {
      label: AnvilManager.ProcessLabel,
      command: config.binary,
      args
    }

    await ProcessManager.get().spawn(procConfig)
    await waitForEndpoint(this.rpcUrl, {
      label: AnvilManager.ProcessLabel,
      timeoutMs: AnvilManager.StartupTimeoutMs
    })
    log.info(`Anvil ready at ${this.rpcUrl} (chainId=${config.chainId})`)
  }

  async stop(): Promise<void> {
    const handle = ProcessManager.get().get(AnvilManager.ProcessLabel)
    if (handle) await handle.kill()
  }
}

export namespace AnvilManager {
  /** Default loopback host for the anvil HTTP RPC. */
  export const DefaultHost = "127.0.0.1"
  /** Default JSON-RPC port. */
  export const DefaultPort = 8545
  /** Default EVM chain id (Foundry's standard). */
  export const DefaultChainId = 31_337
  /** Process-manager label — used as the pid file basename and log prefix. */
  export const ProcessLabel = "anvil" as const
  /** Timeout for waiting on anvil startup (ms). */
  export const StartupTimeoutMs = 15_000
}
