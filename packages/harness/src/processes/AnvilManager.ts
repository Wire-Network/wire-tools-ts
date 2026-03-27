import Fs from "fs"
import { ProcessManager, type ProcessConfig } from "./ProcessManager.js"
import { waitForEndpoint } from "../util.js"
import { log } from "../logger.js"

export interface AnvilConfig {
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

/**
 * Manages an anvil (Foundry) local Ethereum node process.
 */
export class AnvilManager {
  private pm: ProcessManager
  private config: Required<Omit<AnvilConfig, "stateFile" | "extraArgs">> & Pick<AnvilConfig, "stateFile" | "extraArgs">

  constructor(pm: ProcessManager, config: AnvilConfig = {}) {
    this.pm = pm
    this.config = {
      host: config.host ?? "127.0.0.1",
      port: config.port ?? 8545,
      chainId: config.chainId ?? 31337,
      binary: config.binary ?? "anvil",
      stateFile: config.stateFile,
      extraArgs: config.extraArgs,
    }
  }

  get rpcUrl(): string {
    return `http://${this.config.host}:${this.config.port}`
  }

  async start(): Promise<void> {
    const args = [
      "-vvv",
      "--host", this.config.host,
      "--port", String(this.config.port),
      "--chain-id", String(this.config.chainId),
    ]
    if (this.config.stateFile) {
      args.push("--dump-state", this.config.stateFile)
      // Only load state if the file already exists (not first run)
      if (Fs.existsSync(this.config.stateFile)) {
        args.push("--load-state", this.config.stateFile)
      }
    }
    if (this.config.extraArgs) {
      args.push(...this.config.extraArgs)
    }

    const procConfig: ProcessConfig = {
      label: "anvil",
      command: this.config.binary,
      args,
    }

    await this.pm.spawn(procConfig)
    await waitForEndpoint(this.rpcUrl, { label: "anvil", timeoutMs: 15_000 })
    log.info(`Anvil ready at ${this.rpcUrl} (chainId=${this.config.chainId})`)
  }

  async stop(): Promise<void> {
    const handle = this.pm.get("anvil")
    if (handle) await handle.kill()
  }
}
