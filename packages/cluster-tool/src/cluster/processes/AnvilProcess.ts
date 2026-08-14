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
    return new AnvilProcess(
      manager,
      AnvilProcess.resolveConfig(options, { binary, port })
    )
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
    return AnvilProcess.buildArgs(this.config)
  }

  protected get verifyTimeoutMs(): number {
    return AnvilProcess.StartupTimeoutMs
  }

  verifyReady(): Promise<boolean> {
    return probeEndpoint(this.rpcUrl)
  }

  /** Dial URL — `host` mapped through {@link toDialAddress} (a `0.0.0.0` bind dials as loopback). */
  get rpcUrl(): string {
    return toURL(this.config.port, toDialAddress(this.config.host))
  }
}

export namespace AnvilProcess {
  /**
   * Resolve caller options into a complete {@link AnvilConfig}. PURE — every
   * impure input (the PATH-resolved binary, the registry-issued port) is
   * INJECTED, so the same config the process spawns from can be rebuilt for a
   * `start.sh` render without claiming a second port or re-probing PATH.
   *
   * @param options - Caller overrides.
   * @param resolved - The impure values `create` obtained.
   * @returns The complete config.
   */
  /** The impure values `create` resolves (PATH lookup + registry-issued port). */
  export interface ResolvedInputs {
    binary: string
    port: number
  }

  export function resolveConfig(
    options: AnvilOptions,
    resolved: ResolvedInputs
  ): AnvilConfig {
    return {
      host: options.host ?? Localhost,
      port: resolved.port,
      chainId: options.chainId ?? AnvilProcess.DefaultChainId,
      stateFile: options.stateFile ?? null,
      binary: resolved.binary,
      extraArgs: options.extraArgs ?? [],
      slotsInAnEpoch: options.slotsInAnEpoch ?? 0,
      blockTimeSec: options.blockTimeSec ?? 0
    }
  }

  /**
   * The anvil argv (WITHOUT the binary) — the ONE argv source, shared by the
   * live process's {@link AnvilProcess.args} and the `start.sh` renderer.
   *
   * @param config - A resolved anvil config.
   * @returns The argv.
   */
  export function buildArgs(config: AnvilConfig): string[] {
    const args = [
      "-vvv",
      "--host",
      config.host,
      "--port",
      String(config.port),
      "--chain-id",
      String(config.chainId),
      // The WIRE anvil is ALWAYS the outpost deploy target: the deployer
      // (HD index 0) + operator HD accounts must all be pre-funded.
      "--accounts",
      String(AnvilProcess.AccountCount),
      "--balance",
      String(AnvilProcess.BalancePerAccountEther),
      // Mainnet gas parity: pin the EVM revision, enforce EIP-7825's per-tx gas
      // cap, and size the block gas limit — so a transaction mainnet would
      // reject is rejected here too, instead of passing only on the local node.
      "--hardfork",
      AnvilProcess.Hardfork,
      "--enable-tx-gas-limit",
      "--gas-limit",
      String(AnvilProcess.BlockGasLimit)
    ]
    if (config.slotsInAnEpoch)
      args.push("--slots-in-an-epoch", String(config.slotsInAnEpoch))
    if (config.blockTimeSec)
      args.push("--block-time", String(config.blockTimeSec))
    if (config.stateFile) {
      args.push("--dump-state", config.stateFile)
      // Build-time conditional: at CREATE time the state file does not exist
      // yet. A start.sh must therefore render this as a shell test rather than
      // inherit today's answer — see `DaemonArgvCondition`.
      if (Fs.existsSync(config.stateFile))
        args.push("--load-state", config.stateFile)
    }
    args.push(...config.extraArgs)
    return args
  }

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
  /**
   * `--hardfork` — the EVM revision the local node emulates. Pinned so the
   * cluster's gas semantics track mainnet's rather than drifting with whatever
   * revision the installed anvil happens to default to.
   */
  export const Hardfork = "osaka"
  /**
   * `--gas-limit` — the BLOCK gas limit (distinct from EIP-7825's per-transaction
   * cap of 2^24 = 16,777,216, which `--enable-tx-gas-limit` enforces).
   *
   * 60M sits between mainnet's ~30M and the 100M that `wire-ethereum`'s hardhat
   * network configures for its own fixtures: high enough that a block holding
   * several outpost-deploy or envelope-delivery transactions is never the
   * binding constraint, while staying close enough to mainnet that a genuinely
   * oversized transaction still fails here. Raising it hides real gas
   * regressions; lowering it below ~30M diverges from mainnet in the other
   * direction.
   */
  export const BlockGasLimit = 60_000_000
  /** `--accounts` — deployer (HD 0) + operator HD accounts must all be pre-funded. */
  export const AccountCount = 50
  /** `--balance` (ether) per pre-funded account. */
  export const BalancePerAccountEther = 100_000
  /** Subpath (under the cluster data dir) for the anvil dumped-state file. */
  export const StateSubpath = "anvil"
  /** Anvil dumped-state filename (loaded on restart, dumped on stop). */
  export const StateFilename = "anvil.json"
}
