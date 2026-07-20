import Fs from "node:fs"
import Assert from "node:assert"
import { BindConfigProvider } from "../../config/BindConfigProvider.js"
import { probeEndpoint } from "../../utils/asyncUtils.js"
import { existsAsync, which } from "../../utils/fsUtils.js"
import { Localhost, toDialAddress, toURL } from "../../utils/netUtils.js"
import { ManagedProcess } from "./ManagedProcess.js"
import type { ProcessManager } from "./ProcessManager.js"

/** Caller options for an anvil process (all optional; `create` fills the rest). */
export interface AnvilOptions {
  /** Bind host for `--host`. Defaults to loopback. */
  host?: string
  /** RPC port. Defaults to a free port preferring `DefaultAnvil`. */
  port?: number
  /** EVM chain id. */
  chainId?: number
  /** State file path for `--dump-state` / `--load-state` (when present). */
  stateFile?: string | null
  /** anvil binary path. Resolved from PATH when omitted. */
  binary?: string
  /** Additional CLI flags. */
  extraArgs?: string[]
  /** `--slots-in-an-epoch` (run-phase finality emulation; omit during deploy). */
  slotsInAnEpoch?: number
  /** `--block-time` seconds (run-phase interval mining; omit during deploy). */
  blockTimeSec?: number
}

/** Resolved anvil config. */
export interface AnvilConfig extends Required<AnvilOptions> {}

/**
 * Manages an anvil (Foundry) local Ethereum node. The run-phase finality knobs
 * (`slotsInAnEpoch` / `blockTimeSec`) are opt-in — they MUST NOT be set during
 * the deploy phase (`--block-time` disables instamine, which the hardhat deploy
 * depends on).
 */
export class AnvilProcess extends ManagedProcess {
  /**
   * Resolve options → validate the binary → construct (self-registers).
   *
   * @param manager - The owning process manager.
   * @param options - Caller overrides.
   * @returns The constructed anvil process.
   */
  static async create(
    manager: ProcessManager,
    options: AnvilOptions = {}
  ): Promise<AnvilProcess> {
    const { binary = await which("anvil") } = options
    Assert.ok(
      binary != null && (await existsAsync(binary)),
      "anvil binary not found on PATH"
    )
    const {
      port = await BindConfigProvider.findAvailable(
        BindConfigProvider.DefaultAnvil
      )
    } = options
    const config: AnvilConfig = {
      host: options.host ?? Localhost,
      port,
      chainId: options.chainId ?? AnvilProcess.DefaultChainId,
      stateFile: options.stateFile ?? null,
      binary,
      extraArgs: options.extraArgs ?? [],
      slotsInAnEpoch: options.slotsInAnEpoch ?? 0,
      blockTimeSec: options.blockTimeSec ?? 0
    }
    return new AnvilProcess(manager, config)
  }

  private constructor(
    manager: ProcessManager,
    private readonly config: AnvilConfig
  ) {
    super(manager, {
      label: AnvilProcess.ProcessLabel,
      kind: ManagedProcess.Kind.anvil
    })
  }

  get exe(): string {
    return this.config.binary
  }

  get args(): string[] {
    const args = [
      "-vvv",
      "--host",
      this.config.host,
      "--port",
      String(this.config.port),
      "--chain-id",
      String(this.config.chainId),
      // The WIRE anvil is ALWAYS the outpost deploy target: the OPP outpost
      // contracts exceed EIP-170's 24KB code-size limit, and the deployer
      // (HD index 0) + operator HD accounts must all be pre-funded.
      "--code-size-limit",
      AnvilProcess.CodeSizeLimit,
      "--accounts",
      String(AnvilProcess.AccountCount),
      "--balance",
      String(AnvilProcess.BalancePerAccountEther)
    ]
    if (this.config.slotsInAnEpoch)
      args.push("--slots-in-an-epoch", String(this.config.slotsInAnEpoch))
    if (this.config.blockTimeSec)
      args.push("--block-time", String(this.config.blockTimeSec))
    if (this.config.stateFile) {
      args.push("--dump-state", this.config.stateFile)
      if (Fs.existsSync(this.config.stateFile))
        args.push("--load-state", this.config.stateFile)
    }
    args.push(...this.config.extraArgs)
    return args
  }

  protected get verifyTimeoutMs(): number {
    return AnvilProcess.StartupTimeoutMs
  }

  protected verifyReady(): Promise<boolean> {
    return probeEndpoint(this.rpcUrl)
  }

  /** Dial URL — `host` mapped through {@link toDialAddress} (a `0.0.0.0` bind dials as loopback). */
  get rpcUrl(): string {
    return toURL(this.config.port, toDialAddress(this.config.host))
  }
}

export namespace AnvilProcess {
  /** Default EVM chain id (Foundry's standard). */
  export const DefaultChainId = 31_337
  /** `--slots-in-an-epoch` value for the run-phase anvil (finalize after 2 blocks). */
  export const SlotsInAnEpoch = 1
  /** `--block-time` seconds for the run-phase anvil. */
  export const BlockTimeSec = 1
  /** Process label (pid file basename + log prefix). */
  export const ProcessLabel = "anvil" as const
  /** Startup verify timeout (ms). */
  export const StartupTimeoutMs = 60_000
  /** `--code-size-limit` — the OPP outpost contracts exceed EIP-170's 24KB. */
  export const CodeSizeLimit = "99999"
  /** `--accounts` — deployer (HD 0) + operator HD accounts must all be pre-funded. */
  export const AccountCount = 50
  /** `--balance` (ether) per pre-funded account. */
  export const BalancePerAccountEther = 100_000
  /** Subpath (under the cluster data dir) for the anvil dumped-state file. */
  export const StateSubpath = "anvil"
  /** Anvil dumped-state filename (loaded on restart, dumped on stop). */
  export const StateFilename = "anvil.json"
}
