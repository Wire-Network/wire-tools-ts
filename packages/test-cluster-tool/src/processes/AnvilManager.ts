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
  /**
   * If set, pass `--slots-in-an-epoch` (beacon-finality depth). Omit during the
   * deploy phase so anvil keeps default finality; set on the run-phase anvil.
   */
  slotsInAnEpoch?: number
  /**
   * If set, pass `--block-time` seconds (interval mining). Omit during the deploy
   * phase: it disables instamine, which the hardhat deploy depends on. Set only on
   * the run-phase anvil, where contracts are already deployed.
   */
  blockTimeSec?: number
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
    const args = AnvilManager.buildArgs(config)

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
  /** Anvil flags that make every local ETH node simulate Osaka gas behavior. */
  export const OsakaSimulationArgs = [
    "--hardfork",
    "osaka",
    "--enable-tx-gas-limit",
    "--gas-limit",
    "60000000"
  ] as const

  /**
   * Build Anvil argv shared by deploy, bootstrap-restart, and run phases.
   *
   * @param config - Fully resolved Anvil process configuration.
   * @return Command-line arguments passed to the Anvil binary.
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
      ...OsakaSimulationArgs
    ]
    // Beacon-finality emulation -- opt-in, set ONLY for the run-phase anvil (see
    // SlotsInAnEpoch / BlockTimeSec docs). Deliberately omitted during the deploy
    // phase: `--block-time` disables anvil's instamine, which the hardhat deploy
    // (deployLocal.ts) depends on -- enabling it there fails every contract deploy.
    if (config.slotsInAnEpoch) {
      args.push("--slots-in-an-epoch", String(config.slotsInAnEpoch))
    }
    if (config.blockTimeSec) {
      args.push("--block-time", String(config.blockTimeSec))
    }
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
    return args
  }

  /** Default loopback host for the anvil HTTP RPC. */
  export const DefaultHost = "127.0.0.1"
  /** Default JSON-RPC port. */
  export const DefaultPort = 8545
  /** Default EVM chain id (Foundry's standard). */
  export const DefaultChainId = 31_337
  /**
   * Beacon-finality emulation for the RUN-phase anvil only. nodeop's outpost
   * client reads inbound envelopes at the `finalized` block tag (wire-sysio#387;
   * the read commitment is a consensus parameter, not operator-configurable).
   * Stock anvil only mines on transactions and finalizes a block two 32-slot
   * epochs (64 slots) later, so on the harness's quiet dev chain `finalized` sits
   * at genesis forever, every inbound read returns pre-deploy state, no ETH
   * envelope is delivered, and OPP epoch advancement stalls at 1.
   *
   * `--slots-in-an-epoch 1` finalizes a block after 2 blocks instead of 64.
   * `--block-time 1` mines every second regardless of traffic so finality keeps
   * advancing on a quiet chain.
   *
   * CRITICAL: these are applied ONLY to the run-phase anvil (contracts already
   * deployed, loaded from state). They MUST NOT be set during the deploy phase --
   * `--block-time` disables instamine, and the hardhat deploy (deployLocal.ts)
   * depends on instant mining; enabling it there fails every contract deploy.
   * In the run phase the harness only sends plain txs (no deploys), which tolerate
   * the <=1s interval-mining inclusion delay.
   */
  export const SlotsInAnEpoch = 1
  /** Anvil block interval (seconds) — see SlotsInAnEpoch. */
  export const BlockTimeSec = 1
  /** Process-manager label — used as the pid file basename and log prefix. */
  export const ProcessLabel = "anvil" as const
  /** Timeout for waiting on anvil startup (ms). */
  export const StartupTimeoutMs = 15_000
}
