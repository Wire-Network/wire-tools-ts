import Assert from "node:assert"
import Fs from "node:fs"
import { promises as Fsp } from "node:fs"
import Path from "node:path"
import { TokenAmount } from "@wireio/opp-typescript-models"
import type { ChainTokenAmount } from "@wireio/debugging-shared"
import { Level } from "@wireio/shared"
import { LogFileAppender } from "../logging/LogFileAppender.js"
import { Report } from "../report/Report.js"
import type { Renderer } from "../utils/Renderer.js"
import { which } from "../utils/fsUtils.js"
import { Constants } from "../Constants.js"
import { BindConfig } from "./BindConfig.js"
import type {
  ClusterBuildOptions,
  CollateralRequirement,
  LoggingConfig,
  LoggingOptions
} from "./ClusterBuildOptions.js"
import { ClusterConfigGenesisRenderer } from "./renderers/ClusterConfigGenesisRenderer.js"

/**
 * The plain JSON shape persisted to `cluster-config.json`. Single-sourced in
 * `debugging-shared` (consumed there by the debugging server, the TUI, and
 * `PidSources`) — re-exported here so `cluster-tool` consumers keep importing
 * it from `@wireio/cluster-tool/config`.
 */
export type { PersistedClusterConfig } from "@wireio/debugging-shared"

/** Resolved, validated binary locations. */
export interface ClusterExecutablePaths {
  nodeop: string
  kiod: string
  clio: string
  anvil: string
  solanaTestValidator: string
}

/** Throw if a required option is missing (fail-fast at the boundary). */
function assertOption<T>(value: T | null, name: string): T {
  Assert.ok(value != null, `ClusterBuildOptions.${name} is required`)
  return value
}

/**
 * Fully-resolved cluster configuration — the single source of truth persisted
 * to `cluster-config.json` and reloaded by `run` / `destroy`. Built only
 * through {@link ClusterConfig.resolve} (forward path) or
 * {@link ClusterConfig.load} (reload); every field is concrete.
 */
export class ClusterConfig {
  /** The genesis.json renderer for this config. */
  readonly genesis: Renderer = new ClusterConfigGenesisRenderer(this)

  private constructor(
    readonly buildPath: string,
    readonly clusterPath: string,
    readonly dataPath: string,
    readonly walletPath: string,
    readonly producerCount: number,
    readonly nodeCount: number,
    readonly batchOperatorCount: number,
    readonly underwriterCount: number,
    readonly epochDurationSec: number,
    readonly warmupEpochs: number,
    readonly cooldownEpochs: number,
    readonly ethereumPath: string,
    readonly solanaPath: string,
    readonly bind: BindConfig,
    readonly executables: ClusterExecutablePaths,
    readonly report: Report.Config,
    readonly logging: LoggingConfig,
    readonly requiredBatchOperatorCollateral: CollateralRequirement[],
    readonly requiredUnderwriterCollateral: CollateralRequirement[],
    readonly requiredProducerCollateral: CollateralRequirement[],
    readonly underwriterCollateral: ChainTokenAmount[][] | null,
    readonly initialFinalizerKey: string | null
  ) {}

  /**
   * Resolve defaults → validate → return a ready config (the only forward ctor
   * path; reload uses {@link ClusterConfig.load}).
   *
   * @param options - Caller options.
   * @returns The fully-resolved, validated config.
   */
  static async resolve(options: ClusterBuildOptions): Promise<ClusterConfig> {
    const buildPath = assertOption(options.buildPath, "buildPath"),
      clusterPath = assertOption(options.clusterPath, "clusterPath"),
      bind = await BindConfig.resolve(options.bind ?? {}, {
        producerCount: options.nodeCount,
        batchOperatorCount: options.batchOperatorCount,
        underwriterCount: options.underwriterCount,
        bindAll: options.bindAll
      }),
      executables = await ClusterConfig.resolveExecutables(buildPath),
      report = ClusterConfig.resolveReport(options.report, clusterPath),
      logging = ClusterConfig.resolveLogging(options.logging)

    return new ClusterConfig(
      buildPath,
      clusterPath,
      Path.join(clusterPath, ClusterConfig.DataSubpath),
      Path.join(clusterPath, ClusterConfig.WalletSubpath),
      options.producerCount ?? ClusterConfig.DefaultProducerCount,
      options.nodeCount ?? ClusterConfig.DefaultNodeCount,
      options.batchOperatorCount ?? ClusterConfig.DefaultBatchOperatorCount,
      options.underwriterCount ?? ClusterConfig.DefaultUnderwriterCount,
      options.epochDurationSec ?? ClusterConfig.DefaultEpochDurationSec,
      options.warmupEpochs ?? 1,
      options.cooldownEpochs ?? 1,
      assertOption(options.ethereumPath, "ethereumPath"),
      assertOption(options.solanaPath, "solanaPath"),
      bind,
      executables,
      report,
      logging,
      options.requiredBatchOperatorCollateral ?? [],
      options.requiredUnderwriterCollateral ?? [],
      options.requiredProducerCollateral ?? [],
      options.underwriterCollateral ?? null,
      // Genesis initial finalizer = the BIOS BLS key, matching the long-green
      // bootstrap (the real finalizer policy is set later via bios::setfinalizer).
      Constants.DEV_BLS_PUBLIC_KEY
    )
  }

  /** Resolve + validate every binary path (the build-dir bins + PATH lookups). */
  private static async resolveExecutables(
    buildPath: string
  ): Promise<ClusterExecutablePaths> {
    const toBin = (name: string) => Path.join(buildPath, "bin", name)
    const paths: ClusterExecutablePaths = {
      nodeop: toBin("nodeop"),
      kiod: toBin("kiod"),
      clio: toBin("clio"),
      anvil: assertOption(await which("anvil"), "anvil (on PATH)"),
      solanaTestValidator: assertOption(
        await which("solana-test-validator"),
        "solana-test-validator (on PATH)"
      )
    }
    ;[paths.nodeop, paths.kiod, paths.clio].forEach(p =>
      Assert.ok(Fs.existsSync(p), `binary not found at ${p}`)
    )
    return paths
  }

  /** Build the resolved `Report.Config` from the optional caller leaf. */
  private static resolveReport(
    options: Report.Options | null,
    clusterPath: string
  ): Report.Config {
    return {
      path: options?.path ?? Path.join(clusterPath, ClusterConfig.ReportSubpath),
      basename: options?.basename ?? ClusterConfig.DefaultReportBasename,
      formats: options?.formats ?? [
        Report.Format.csv,
        Report.Format.md,
        Report.Format.html
      ]
    }
  }

  /** Build the resolved `LoggingConfig` from the optional caller leaf. */
  private static resolveLogging(
    options: LoggingOptions | null
  ): LoggingConfig {
    return {
      levels: {
        console: options?.levels?.console ?? Level.info,
        file: options?.levels?.file ?? Level.debug
      },
      fileFormat: options?.fileFormat ?? LogFileAppender.Format.jsonl
    }
  }

  /** Absolute path of the persisted config file. */
  get configFilePath(): string {
    return Path.join(this.clusterPath, ClusterConfig.ConfigFilename)
  }

  /** Absolute path of the shared cluster genesis (every nodeop points `--genesis-json` here). */
  get genesisFile(): string {
    return Path.join(this.clusterPath, ClusterConfig.GenesisFilename)
  }

  /**
   * THIS cluster's Ethereum deploy-artifact dir (deploy configs +
   * `outpost-addrs.json` / `liqeth-addrs.json` outputs). Per-cluster BY
   * DESIGN: the pre-rewrite location — `<wire-ethereum>/.local/deployments/`,
   * shared repo state — made parallel flows clobber each other's deploy
   * configs and address files mid-deploy (2026-07-02 pair-1 incident). The
   * harness points `deployLocal.ts` here via `WIRE_ETH_DEPLOYMENTS_PATH`.
   */
  get ethereumDeploymentsPath(): string {
    return Path.join(this.dataPath, "ethereum-deployments")
  }

  // ── persistence (folds ClusterConfigPersistence) ──

  /** Serialise to `cluster-config.json` (projecting `underwriterCollateral` bigints). Fluent. */
  async save(): Promise<ClusterConfig> {
    await Fsp.writeFile(this.configFilePath, ClusterConfig.serialize(this))
    return this
  }

  /** Read + rehydrate a config from `path` (async). */
  static async load(path: string): Promise<ClusterConfig> {
    return ClusterConfig.deserialize(await Fsp.readFile(path, "utf-8"))
  }

  /** Read + rehydrate a config from `path` (sync). */
  static loadSync(path: string): ClusterConfig {
    return ClusterConfig.deserialize(Fs.readFileSync(path, "utf-8"))
  }

  /**
   * Serialise `config` to pretty JSON. `underwriterCollateral` carries proto
   * `TokenAmount` (bigint) → projected via `TokenAmount.toJson` (string int64).
   *
   * @param config - The config to serialise.
   * @returns The JSON string.
   */
  static serialize(config: ClusterConfig): string {
    // projected is the JSON form (amount via TokenAmount.toJson) — left to infer
    // so the serialized amount doesn't conflict with the runtime ChainTokenAmount.
    const projected = {
      buildPath: config.buildPath,
      clusterPath: config.clusterPath,
      dataPath: config.dataPath,
      walletPath: config.walletPath,
      producerCount: config.producerCount,
      nodeCount: config.nodeCount,
      batchOperatorCount: config.batchOperatorCount,
      underwriterCount: config.underwriterCount,
      epochDurationSec: config.epochDurationSec,
      warmupEpochs: config.warmupEpochs,
      cooldownEpochs: config.cooldownEpochs,
      ethereumPath: config.ethereumPath,
      solanaPath: config.solanaPath,
      bind: {
        kiod: config.bind.kiod,
        nodeop: config.bind.nodeop,
        anvil: config.bind.anvil,
        solana: config.bind.solana,
        debuggingServer: config.bind.debuggingServer
      },
      executables: config.executables,
      report: config.report,
      logging: config.logging,
      requiredBatchOperatorCollateral: config.requiredBatchOperatorCollateral,
      requiredUnderwriterCollateral: config.requiredUnderwriterCollateral,
      requiredProducerCollateral: config.requiredProducerCollateral,
      underwriterCollateral:
        config.underwriterCollateral?.map(arr =>
          arr.map(entry => ({
            chain_code: entry.chain_code,
            amount: TokenAmount.toJson(entry.amount)
          }))
        ) ?? null,
      initialFinalizerKey: config.initialFinalizerKey
    }
    return JSON.stringify(projected, null, 2)
  }

  /**
   * Parse + rehydrate a persisted config. `underwriterCollateral.amount` is
   * restored via `TokenAmount.fromJson`; `bind` is rebuilt into a `BindConfig`
   * instance. Does NOT re-validate / re-claim ports (reload, not resolve).
   *
   * @param input - Raw JSON string.
   * @returns The rehydrated config.
   */
  static deserialize(input: string): ClusterConfig {
    // parsed is the JSON form; amount is rehydrated to a TokenAmount via fromJson,
    // yielding ChainTokenAmount entries again.
    const parsed = JSON.parse(input)
    const underwriterCollateral: ChainTokenAmount[][] | null =
      parsed.underwriterCollateral?.map(arr =>
        arr.map(raw => ({
          chain_code: raw.chain_code,
          amount: TokenAmount.fromJson(raw.amount)
        }))
      ) ?? null
    const bind = new BindConfig(
      parsed.bind.kiod,
      parsed.bind.nodeop,
      parsed.bind.anvil,
      parsed.bind.solana,
      parsed.bind.debuggingServer
    )
    return new ClusterConfig(
      parsed.buildPath,
      parsed.clusterPath,
      parsed.dataPath,
      parsed.walletPath,
      parsed.producerCount,
      parsed.nodeCount,
      parsed.batchOperatorCount,
      parsed.underwriterCount,
      parsed.epochDurationSec,
      parsed.warmupEpochs,
      parsed.cooldownEpochs,
      parsed.ethereumPath,
      parsed.solanaPath,
      bind,
      parsed.executables,
      parsed.report,
      parsed.logging,
      parsed.requiredBatchOperatorCollateral,
      parsed.requiredUnderwriterCollateral,
      parsed.requiredProducerCollateral,
      underwriterCollateral,
      parsed.initialFinalizerKey
    )
  }
}

export namespace ClusterConfig {
  export const DataSubpath = "data"
  export const WalletSubpath = "wallet"
  export const ReportSubpath = "reports"
  export const ConfigFilename = "cluster-config.json"
  export const GenesisFilename = "genesis.json"
  export const DefaultReportBasename = "cluster-build"
  export const DefaultProducerCount = 21
  export const DefaultNodeCount = 1
  export const DefaultBatchOperatorCount = 3
  export const DefaultUnderwriterCount = 1
  export const DefaultEpochDurationSec = 90
}
