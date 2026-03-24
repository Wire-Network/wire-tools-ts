import path from "path"
import fs from "fs"
import { ProcessManager, type ProcessConfig } from "./process-manager.js"
import { waitForEndpoint, sleep } from "../util.js"
import { log } from "../logger.js"

export interface WireChainConfig {
  /** Path to wire-sysio build directory */
  buildDir: string
  /** Chain data directory (created if absent) */
  chainDir: string
  /** HTTP API port (default: 8888) */
  httpPort?: number
  /** P2P port (default: 9876) */
  p2pPort?: number
  /** Additional nodeop plugins to enable */
  plugins?: string[]
  /** Additional nodeop CLI flags */
  extraArgs?: string[]
}

/**
 * Manages nodeop + kiod processes for a local WIRE chain.
 * Follows the patterns from cluster_manager.py.
 */
export class WireChainManager {
  private pm: ProcessManager
  private config: WireChainConfig & { httpPort: number; p2pPort: number }

  constructor(pm: ProcessManager, config: WireChainConfig) {
    this.pm = pm
    this.config = {
      ...config,
      httpPort: config.httpPort ?? 8888,
      p2pPort: config.p2pPort ?? 9876,
    }
  }

  get nodeop(): string {
    return path.join(this.config.buildDir, "bin", "nodeop")
  }

  get kiod(): string {
    return path.join(this.config.buildDir, "bin", "kiod")
  }

  get clio(): string {
    return path.join(this.config.buildDir, "bin", "clio")
  }

  get httpUrl(): string {
    return `http://127.0.0.1:${this.config.httpPort}`
  }

  async start(): Promise<void> {
    // Ensure chain dir exists
    fs.mkdirSync(this.config.chainDir, { recursive: true })

    // Start kiod first
    await this.pm.spawn({
      label: "kiod",
      command: this.kiod,
      args: [
        "--wallet-dir", path.join(this.config.chainDir, "wallets"),
        "--unlock-timeout", "999999999",
      ],
      cwd: this.config.chainDir,
    })
    await sleep(1000)

    // Build nodeop args
    const args = [
      "--data-dir", path.join(this.config.chainDir, "data"),
      "--config-dir", path.join(this.config.chainDir, "config"),
      "--http-server-address", `0.0.0.0:${this.config.httpPort}`,
      "--p2p-listen-endpoint", `0.0.0.0:${this.config.p2pPort}`,
      "--enable-stale-production",
      "--producer-name", "sysio",
      "--plugin", "sysio::chain_api_plugin",
      "--plugin", "sysio::producer_plugin",
      "--plugin", "sysio::producer_api_plugin",
      "--plugin", "sysio::http_plugin",
    ]

    for (const plugin of this.config.plugins || []) {
      args.push("--plugin", plugin)
    }

    if (this.config.extraArgs) {
      args.push(...this.config.extraArgs)
    }

    await this.pm.spawn({
      label: "nodeop",
      command: this.nodeop,
      args,
      cwd: this.config.chainDir,
    })

    await waitForEndpoint(`${this.httpUrl}/v1/chain/get_info`, {
      label: "nodeop",
      timeoutMs: 30_000,
    })
    log.info(`WIRE chain ready at ${this.httpUrl}`)
  }

  async stop(): Promise<void> {
    // Stop nodeop first, then kiod (reverse order)
    const nodeop = this.pm.get("nodeop")
    if (nodeop) await nodeop.kill()
    const kiod = this.pm.get("kiod")
    if (kiod) await kiod.kill()
  }
}
