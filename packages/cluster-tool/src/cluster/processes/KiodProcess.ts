import Assert from "node:assert"
import { BindConfigProvider } from "../../config/BindConfigProvider.js"
import { probeEndpoint } from "../../utils/asyncUtils.js"
import { existsAsync } from "../../utils/fsUtils.js"
import { Localhost, toDialAddress, toURL } from "../../utils/netUtils.js"
import { ManagedProcess } from "./ManagedProcess.js"
import type { ProcessManager } from "./ProcessManager.js"

/** Caller options for the kiod wallet daemon. */
export interface KiodOptions {
  /** kiod binary (from the build dir's bin/). Required. */
  binary?: string
  /** Wallet directory (data/config/wallet dir + cwd). Required. */
  walletPath?: string
  /** Listen address (from `bind.kiod.address`). Defaults to loopback. */
  address?: string
  /** HTTP port. Defaults to a free port preferring `DefaultKiod`. */
  port?: number
  /** Unlock timeout (seconds). */
  unlockTimeout?: number
  /** `--http-max-response-time-ms`. */
  httpMaxResponseTimeMs?: number
  /** Additional CLI flags. */
  extraArgs?: string[]
}

/** Resolved kiod config. */
export interface KiodConfig extends Required<KiodOptions> {}

/** Manages a kiod (wallet daemon) process. */
export class KiodProcess extends ManagedProcess {
  static async create(
    manager: ProcessManager,
    options: KiodOptions = {}
  ): Promise<KiodProcess> {
    Assert.ok(
      options.binary != null && (await existsAsync(options.binary)),
      "kiod binary is required"
    )
    Assert.ok(
      options.walletPath != null && (await existsAsync(options.walletPath)),
      "kiod walletPath is required"
    )
    const {
      port = await BindConfigProvider.findAvailable(
        BindConfigProvider.DefaultKiod
      )
    } = options
    const config: KiodConfig = {
      binary: options.binary,
      walletPath: options.walletPath,
      address: options.address ?? Localhost,
      port,
      unlockTimeout: options.unlockTimeout ?? KiodProcess.DefaultUnlockTimeout,
      httpMaxResponseTimeMs:
        options.httpMaxResponseTimeMs ??
        KiodProcess.DefaultHttpMaxResponseTimeMs,
      extraArgs: options.extraArgs ?? []
    }
    return new KiodProcess(manager, config)
  }

  private constructor(
    manager: ProcessManager,
    private readonly config: KiodConfig
  ) {
    super(manager, {
      label: KiodProcess.ProcessLabel,
      kind: ManagedProcess.Kind.kiod
    })
  }

  get exe(): string {
    return this.config.binary
  }

  /** kiod runs out of its wallet directory. */
  override get cwd(): string {
    return this.config.walletPath
  }

  get args(): string[] {
    return [
      "--wallet-dir",
      this.config.walletPath,
      "--data-dir",
      this.config.walletPath,
      "--config-dir",
      this.config.walletPath,
      `--unlock-timeout=${this.config.unlockTimeout}`,
      `--http-server-address=${this.config.address}:${this.config.port}`,
      "--http-max-response-time-ms",
      String(this.config.httpMaxResponseTimeMs),
      "--verbose-http-errors",
      ...this.config.extraArgs
    ]
  }

  protected get verifyTimeoutMs(): number {
    return KiodProcess.StartupTimeoutMs
  }

  protected verifyReady(): Promise<boolean> {
    return probeEndpoint(`${this.httpUrl}${KiodProcess.HealthCheckPath}`)
  }

  get httpUrl(): string {
    return toURL(this.config.port, toDialAddress(this.config.address))
  }
}

export namespace KiodProcess {
  export const DefaultUnlockTimeout = 999_999
  export const DefaultHttpMaxResponseTimeMs = 99_999
  export const ProcessLabel = "kiod" as const
  /** Endpoint polled to confirm kiod is up. */
  export const HealthCheckPath = "/v1/wallet/list_wallets" as const
  export const StartupTimeoutMs = 60_000
}
