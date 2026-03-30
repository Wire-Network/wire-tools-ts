import { ProcessManager, type ProcessConfig } from "./ProcessManager.js"
import { existsAsync, waitForEndpoint } from "../util.js"
import { log } from "../logger.js"
import { defaults } from "lodash"
import { assert } from "@wireio/shared"

export interface KiodOptions {
  /** Path to kiod binary */
  binary?: string
  /** Wallet directory */
  walletPath?: string
  /** HTTP port (default: 8900) */
  port?: number
  /** Unlock timeout in seconds (default: 999999) */
  unlockTimeout?: number
  /** HTTP max response time in ms (default: 99999) */
  httpMaxResponseTimeMs?: number
  /** Additional CLI flags */
  extraArgs?: string[]
}

export function createKiodDefaultOptions(): Partial<KiodOptions> {
  return {
    port: KiodManager.DefaultPort,
    unlockTimeout: KiodManager.DefaultUnlockTimeout,
    httpMaxResponseTimeMs: KiodManager.DefaultHttpMaxResponseTimeMs
  }
}

export interface KiodConfig extends Required<KiodOptions> {}

/**
 * Manages a kiod (wallet daemon) process.
 */
export class KiodManager {
  static async create(options: KiodOptions = {}) {
    const config = defaults(
      { ...options },
      createKiodDefaultOptions()
    ) as KiodConfig
    assert(await existsAsync(config.binary), "kiod binary path is required")
    assert(
      await existsAsync(config.walletPath),
      "kiod walletPath is required"
    )
    return new KiodManager(config)
  }

  private constructor(readonly config: KiodConfig) {}

  get httpUrl(): string {
    return `http://127.0.0.1:${this.config.port}`
  }

  async start(): Promise<void> {
    const { config } = this
    const args = [
      "--wallet-dir",
      config.walletPath,
      "--data-dir",
      config.walletPath,
      "--config-dir",
      config.walletPath,
      `--unlock-timeout=${config.unlockTimeout}`,
      `--http-server-address=127.0.0.1:${config.port}`,
      "--http-max-response-time-ms",
      String(config.httpMaxResponseTimeMs),
      "--verbose-http-errors"
    ]
    if (config.extraArgs) {
      args.push(...config.extraArgs)
    }

    const procConfig: ProcessConfig = {
      label: "kiod",
      command: config.binary,
      args,
      cwd: config.walletPath
    }

    await ProcessManager.get().spawn(procConfig)
    await waitForEndpoint(`${this.httpUrl}/v1/wallet/list_wallets`, {
      label: "kiod",
      timeoutMs: KiodManager.StartupTimeoutMs
    })
    log.info(`kiod ready at ${this.httpUrl}`)
  }

  async stop(): Promise<void> {
    const handle = ProcessManager.get().get("kiod")
    if (handle) await handle.kill()
  }
}

export namespace KiodManager {
  export const DefaultPort = 8900
  export const DefaultUnlockTimeout = 999999
  export const DefaultHttpMaxResponseTimeMs = 99999

  /** Timeout for waiting on kiod startup (ms). */
  export const StartupTimeoutMs = 10_000
}
