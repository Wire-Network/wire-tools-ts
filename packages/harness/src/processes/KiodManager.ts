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
    assert(await existsAsync(config.walletPath), "kiod walletPath is required")
    return new KiodManager(config)
  }

  private constructor(readonly config: KiodConfig) {}

  get httpUrl(): string {
    return `http://${KiodManager.DefaultHost}:${this.config.port}`
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
      `--http-server-address=${KiodManager.DefaultHost}:${config.port}`,
      "--http-max-response-time-ms",
      String(config.httpMaxResponseTimeMs),
      "--verbose-http-errors"
    ]
    if (config.extraArgs) {
      args.push(...config.extraArgs)
    }

    const procConfig: ProcessConfig = {
      label: KiodManager.ProcessLabel,
      command: config.binary,
      args,
      cwd: config.walletPath
    }

    await ProcessManager.get().spawn(procConfig)
    await waitForEndpoint(
      `${this.httpUrl}${KiodManager.HealthCheckPath}`,
      {
        label: KiodManager.ProcessLabel,
        timeoutMs: KiodManager.StartupTimeoutMs
      }
    )
    log.info(`kiod ready at ${this.httpUrl}`)
  }

  async stop(): Promise<void> {
    const handle = ProcessManager.get().get(KiodManager.ProcessLabel)
    if (handle) await handle.kill()
  }
}

export namespace KiodManager {
  /** Loopback host kiod binds to. */
  export const DefaultHost = "127.0.0.1"
  /** Default HTTP API port. */
  export const DefaultPort = 8900
  /** Default unlock timeout (seconds). Effectively "until process exits". */
  export const DefaultUnlockTimeout = 999_999
  /** Default `--http-max-response-time-ms`. */
  export const DefaultHttpMaxResponseTimeMs = 99_999
  /** Process-manager label — pid file basename + log prefix. */
  export const ProcessLabel = "kiod" as const
  /** Endpoint polled to confirm kiod is up. */
  export const HealthCheckPath = "/v1/wallet/list_wallets" as const
  /** Timeout for waiting on kiod startup (ms). */
  export const StartupTimeoutMs = 10_000
}
