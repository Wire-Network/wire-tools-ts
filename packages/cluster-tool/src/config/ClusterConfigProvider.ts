import Assert from "node:assert"
import Fs from "node:fs"
import { promises as Fsp } from "node:fs"
import Path from "node:path"
import { TokenAmount } from "@wireio/opp-typescript-models"
import {
  ClusterFiles,
  type ChainTokenAmount,
  type ClusterConfig,
  type ClusterConfigLogging,
  type ClusterExecutablePaths
} from "@wireio/cluster-tool-shared"
import { Level } from "@wireio/shared"
import { LogFileAppender } from "../logging/LogFileAppender.js"
import { Report } from "../report/Report.js"
import type { Renderer } from "../utils/Renderer.js"
import { which } from "../utils/fsUtils.js"
import { Constants } from "../Constants.js"
import { BindConfigProvider } from "./BindConfigProvider.js"
import type {
  ClusterBuildOptions,
  LoggingOptions
} from "./ClusterBuildOptions.js"
import { ClusterConfigGenesisRenderer } from "./renderers/ClusterConfigGenesisRenderer.js"

/** Throw if a required option is missing (fail-fast at the boundary). */
function assertOption<T>(value: T | null, name: string): T {
  Assert.ok(value != null, `ClusterBuildOptions.${name} is required`)
  return value
}

/**
 * Hydrates and persists the cluster configuration — the behavior half of the
 * plain-data `ClusterConfig` shape (`@wireio/cluster-tool-shared`). Plain
 * `ClusterConfig` values flow through the harness; this provider owns the
 * forward resolution ({@link ClusterConfigProvider.resolve}), the reload path
 * ({@link ClusterConfigProvider.load} / {@link ClusterConfigProvider.loadSync}),
 * persistence ({@link ClusterConfigProvider.save}), and every derived-path
 * helper.
 */
export namespace ClusterConfigProvider {
  export const DataSubpath = "data"
  export const WalletSubpath = "wallet"
  export const ReportSubpath = "reports"
  export const ConfigFilename = ClusterFiles.ConfigFilename
  export const GenesisFilename = "genesis.json"
  export const DefaultReportBasename = "cluster-build"
  export const DefaultProducerCount = 21
  export const DefaultNodeCount = 1
  export const DefaultBatchOperatorCount = 3
  export const DefaultUnderwriterCount = 1
  export const DefaultEpochDurationSec = 90

  /**
   * Resolve defaults → validate → return a ready config (the only forward
   * construction path; reload uses {@link ClusterConfigProvider.load}).
   *
   * @param options - Caller options.
   * @returns The fully-resolved, validated config.
   */
  export async function resolve(
    options: ClusterBuildOptions
  ): Promise<ClusterConfig> {
    const buildPath = assertOption(options.buildPath, "buildPath"),
      clusterPath = assertOption(options.clusterPath, "clusterPath"),
      bind = await BindConfigProvider.resolve(options.bind ?? {}, {
        producerCount: options.nodeCount,
        batchOperatorCount: options.batchOperatorCount,
        underwriterCount: options.underwriterCount,
        bindAll: options.bindAll
      }),
      executables = await resolveExecutables(buildPath),
      report = resolveReport(options.report, clusterPath),
      logging = resolveLogging(options.logging)

    return {
      buildPath,
      clusterPath,
      dataPath: Path.join(clusterPath, DataSubpath),
      walletPath: Path.join(clusterPath, WalletSubpath),
      producerCount: options.producerCount ?? DefaultProducerCount,
      nodeCount: options.nodeCount ?? DefaultNodeCount,
      batchOperatorCount:
        options.batchOperatorCount ?? DefaultBatchOperatorCount,
      underwriterCount: options.underwriterCount ?? DefaultUnderwriterCount,
      epochDurationSec: options.epochDurationSec ?? DefaultEpochDurationSec,
      warmupEpochs: options.warmupEpochs ?? 1,
      cooldownEpochs: options.cooldownEpochs ?? 1,
      ethereumPath: assertOption(options.ethereumPath, "ethereumPath"),
      solanaPath: assertOption(options.solanaPath, "solanaPath"),
      bind,
      executables,
      report,
      logging,
      requiredBatchOperatorCollateral:
        options.requiredBatchOperatorCollateral ?? [],
      requiredUnderwriterCollateral:
        options.requiredUnderwriterCollateral ?? [],
      requiredProducerCollateral: options.requiredProducerCollateral ?? [],
      underwriterCollateral: options.underwriterCollateral ?? null,
      // Genesis initial finalizer = the BIOS BLS key, matching the long-green
      // bootstrap (the real finalizer policy is set later via bios::setfinalizer).
      initialFinalizerKey: Constants.DEV_BLS_PUBLIC_KEY
    }
  }

  /** Resolve + validate every binary path (the build-dir bins + PATH lookups). */
  async function resolveExecutables(
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
  function resolveReport(
    options: Report.Options | null,
    clusterPath: string
  ): Report.Config {
    return {
      path: options?.path ?? Path.join(clusterPath, ReportSubpath),
      basename: options?.basename ?? DefaultReportBasename,
      formats: options?.formats ?? [
        Report.Format.csv,
        Report.Format.md,
        Report.Format.html
      ]
    }
  }

  /** Build the resolved `ClusterConfigLogging` from the optional caller leaf. */
  function resolveLogging(
    options: LoggingOptions | null
  ): ClusterConfigLogging {
    return {
      levels: {
        console: options?.levels?.console ?? Level.info,
        file: options?.levels?.file ?? Level.debug
      },
      fileFormat: options?.fileFormat ?? LogFileAppender.Format.jsonl
    }
  }

  /**
   * The genesis.json renderer for a config.
   *
   * @param config - The cluster configuration.
   * @returns A renderer producing the cluster's shared genesis document.
   */
  export function genesisRenderer(config: ClusterConfig): Renderer {
    return new ClusterConfigGenesisRenderer(config)
  }

  /**
   * Absolute path of the persisted config file.
   *
   * @param config - The cluster configuration.
   * @returns `<clusterPath>/cluster-config.json`.
   */
  export function configFilePath(config: ClusterConfig): string {
    return Path.join(config.clusterPath, ConfigFilename)
  }

  /**
   * Absolute path of the shared cluster genesis (every nodeop points
   * `--genesis-json` here).
   *
   * @param config - The cluster configuration.
   * @returns `<clusterPath>/genesis.json`.
   */
  export function genesisFile(config: ClusterConfig): string {
    return Path.join(config.clusterPath, GenesisFilename)
  }

  /**
   * THIS cluster's Ethereum deploy-artifact dir (deploy configs +
   * `outpost-addrs.json` / `liqeth-addrs.json` outputs). Per-cluster BY
   * DESIGN: the pre-rewrite location — `<wire-ethereum>/.local/deployments/`,
   * shared repo state — made parallel flows clobber each other's deploy
   * configs and address files mid-deploy (2026-07-02 pair-1 incident). The
   * harness points `deployLocal.ts` here via `WIRE_ETH_DEPLOYMENTS_PATH`.
   *
   * @param config - The cluster configuration.
   * @returns `<dataPath>/ethereum-deployments`.
   */
  export function ethereumDeploymentsPath(config: ClusterConfig): string {
    return Path.join(config.dataPath, "ethereum-deployments")
  }

  /**
   * Clone `config` with a different report basename — `run` writes
   * `cluster-run.*` beside (never over) `create`'s `cluster-build.*`.
   *
   * @param config - The source configuration (not mutated).
   * @param basename - The report basename for the clone.
   * @returns The cloned configuration.
   */
  export function withReportBasename(
    config: ClusterConfig,
    basename: string
  ): ClusterConfig {
    return { ...config, report: { ...config.report, basename } }
  }

  // ── persistence ──

  /**
   * Serialise `config` to `cluster-config.json` (projecting
   * `underwriterCollateral` bigints).
   *
   * @param config - The config to persist.
   * @returns The persisted config, for chaining.
   */
  export async function save(config: ClusterConfig): Promise<ClusterConfig> {
    await Fsp.writeFile(configFilePath(config), serialize(config))
    return config
  }

  /**
   * Read + rehydrate a config from `path` (async).
   *
   * @param path - Absolute path of a persisted `cluster-config.json`.
   * @returns The rehydrated config.
   */
  export async function load(path: string): Promise<ClusterConfig> {
    return deserialize(await Fsp.readFile(path, "utf-8"))
  }

  /**
   * Read + rehydrate a config from `path` (sync).
   *
   * @param path - Absolute path of a persisted `cluster-config.json`.
   * @returns The rehydrated config.
   */
  export function loadSync(path: string): ClusterConfig {
    return deserialize(Fs.readFileSync(path, "utf-8"))
  }

  /**
   * Serialise `config` to pretty JSON. `underwriterCollateral` carries proto
   * `TokenAmount` (bigint) → projected via `TokenAmount.toJson` (string int64);
   * every other field is already plain JSON — the persisted document IS the
   * `ClusterConfig` shape.
   *
   * @param config - The config to serialise.
   * @returns The JSON string.
   */
  export function serialize(config: ClusterConfig): string {
    // projected is the JSON form (amount via TokenAmount.toJson) — left to infer
    // so the serialized amount doesn't conflict with the runtime ChainTokenAmount.
    const projected = {
      ...config,
      underwriterCollateral:
        config.underwriterCollateral?.map(arr =>
          arr.map(entry => ({
            chain_code: entry.chain_code,
            amount: TokenAmount.toJson(entry.amount)
          }))
        ) ?? null
    }
    return JSON.stringify(projected, null, 2)
  }

  /**
   * Parse + rehydrate a persisted config. `underwriterCollateral.amount` is
   * restored via `TokenAmount.fromJson`; everything else IS the plain
   * `ClusterConfig` shape. Does NOT re-validate / re-claim ports (reload, not
   * resolve) — `run` re-probes via `BindConfigProvider.validate`.
   *
   * @param input - Raw JSON string.
   * @returns The rehydrated config.
   */
  export function deserialize(input: string): ClusterConfig {
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
    return { ...parsed, underwriterCollateral }
  }
}
