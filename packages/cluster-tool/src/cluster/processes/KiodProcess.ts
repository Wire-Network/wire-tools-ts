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
  static async create(manager: ProcessManager, options: KiodOptions = {}): Promise<KiodProcess> {
    Assert.ok(options.binary != null && (await existsAsync(options.binary)), "kiod binary is required")
    Assert.ok(options.walletPath != null && (await existsAsync(options.walletPath)), "kiod walletPath is required")
    const { port = await BindConfigProvider.findAvailable(BindConfigProvider.DefaultKiod) } = options
    return new KiodProcess(manager, KiodProcess.resolveConfig(options, { port }))
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
    return KiodProcess.buildArgs(this.config)
  }

  protected get verifyTimeoutMs(): number {
    return KiodProcess.StartupTimeoutMs
  }

  verifyReady(): Promise<boolean> {
    return probeEndpoint(`${this.httpUrl}${KiodProcess.HealthCheckPath}`)
  }

  get httpUrl(): string {
    return toURL(this.config.port, toDialAddress(this.config.address))
  }
}

export namespace KiodProcess {
  /**
   * Resolve caller options into a complete {@link KiodConfig}. PURE — the
   * registry-issued port is INJECTED, so a `start.sh` render rebuilds the same
   * config without claiming a second port.
   *
   * @param options - Caller overrides (`binary` + `walletPath` asserted by `create`).
   * @param resolved - The impure values `create` obtained.
   * @returns The complete config.
   */
  /** The impure value `create` resolves (registry-issued port). */
  export interface ResolvedInputs {
    port: number
  }

  export function resolveConfig(options: KiodOptions, resolved: ResolvedInputs): KiodConfig {
    return {
      binary: options.binary,
      walletPath: options.walletPath,
      address: options.address ?? Localhost,
      port: resolved.port,
      unlockTimeout: options.unlockTimeout ?? KiodProcess.DefaultUnlockTimeout,
      httpMaxResponseTimeMs: options.httpMaxResponseTimeMs ?? KiodProcess.DefaultHttpMaxResponseTimeMs,
      extraArgs: options.extraArgs ?? []
    }
  }

  /**
   * The kiod argv (WITHOUT the binary) — the ONE argv source, shared by the live
   * process and the `start.sh` renderer.
   *
   * Every path here is the cluster's WALLET directory: kiod points
   * `--wallet-dir` / `--data-dir` / `--config-dir` all at it and runs with it as
   * `cwd`. Its own `data/kiod/` directory holds only the pidfile and log, so a
   * rendered script has no `$NODE_DIR` substitution to make.
   *
   * @param config - A resolved kiod config.
   * @returns The argv.
   */
  export function buildArgs(config: KiodConfig): string[] {
    return [
      "--wallet-dir",
      config.walletPath,
      "--data-dir",
      config.walletPath,
      "--config-dir",
      config.walletPath,
      `--unlock-timeout=${config.unlockTimeout}`,
      `--http-server-address=${config.address}:${config.port}`,
      "--http-max-response-time-ms",
      String(config.httpMaxResponseTimeMs),
      "--verbose-http-errors",
      ...config.extraArgs
    ]
  }

  export const DefaultUnlockTimeout = 999_999
  export const DefaultHttpMaxResponseTimeMs = 99_999
  export const ProcessLabel = "kiod" as const
  /** Endpoint polled to confirm kiod is up. */
  export const HealthCheckPath = "/v1/wallet/list_wallets" as const
  export const StartupTimeoutMs = 60_000
}
