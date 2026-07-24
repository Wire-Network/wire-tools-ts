import Assert from "node:assert"
import Fs from "node:fs"
import { promises as Fsp } from "node:fs"
import Path from "node:path"
import {
  BindConfigSchemaCodec,
  BindOptionsSchema,
  ClusterConfigSchemaCodec,
  ClusterFiles,
  ExternalOutpostConfigSchemaCodec,
  SignatureProviderType,
  type BindConfig,
  type BindOptions,
  type ClusterConfig,
  type ClusterConfigLogging,
  type ClusterExecutablePaths,
  type ClusterSignatureProviderConfig,
  type ClusterSignatureProviderOptions,
  type ClusterTopologyOptions,
  type ExternalOutpostConfig
} from "@wireio/cluster-tool-shared"
import { defaultsDeep } from "lodash"
import { Level } from "@wireio/shared"
import { KeyType } from "@wireio/sdk-core"
import { KeyGenerator } from "../clients/wire/KeyGenerator.js"
import {
  ListenAllAddress,
  Localhost,
  toDialAddress,
  toURL
} from "../utils/netUtils.js"
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
      bind = await resolveBind(options),
      executables = await resolveExecutables(buildPath),
      report = resolveReport(options.report, clusterPath),
      logging = resolveLogging(options.logging),
      signatureProvider = resolveSignatureProvider(options.signatureProvider),
      externalOutposts = await loadExternalOutposts(
        options.externalOutpostConfig
      )

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
      operatorsPerEpoch: options.operatorsPerEpoch ?? null,
      batchOpGroups: options.batchOpGroups ?? null,
      epochRetentionEnvelopeLogCount:
        options.epochRetentionEnvelopeLogCount ?? null,
      warmupEpochs: options.warmupEpochs ?? 1,
      cooldownEpochs: options.cooldownEpochs ?? 1,
      terminateMaxConsecutiveMisses:
        options.terminateMaxConsecutiveMisses ?? null,
      terminateMaxPercentMisses24h: options.terminateMaxPercentMisses24h ?? null,
      terminateWindowMs: options.terminateWindowMs ?? null,
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
      initialFinalizerKey: Constants.DEV_BLS_PUBLIC_KEY,
      signatureProvider,
      externalOutposts,
      debuggingServerEnabled: true,
      enableMockReserves: options.enableMockReserves ?? false
    }
  }

  /**
   * Resolve the cluster signature-provider config: default {@link
   * SignatureProviderType.KEY}, and validate that SSM settings are present iff
   * the type is `SSM`.
   *
   * @param options - Caller signature-provider options (may be omitted).
   * @returns The resolved, validated config.
   */
  function resolveSignatureProvider(
    options: ClusterSignatureProviderOptions
  ): ClusterSignatureProviderConfig {
    const { type = SignatureProviderType.KEY, ssm = null } = options ?? {}
    Assert.ok(
      type !== SignatureProviderType.SSM || ssm != null,
      "signatureProvider.ssm (awsRegion + awsSecretIdPattern) is required when type is SSM"
    )
    Assert.ok(
      ssm == null || type === SignatureProviderType.SSM,
      "signatureProvider.ssm is only valid when type is SSM"
    )
    return { type, ssm }
  }

  /**
   * Resolve the cluster's network binding. Without `--bind-config` the resolver
   * picks free ports (current behavior). WITH `--bind-config`, the file is
   * classified via {@link BindConfigSchemaCodec}'s `check`:
   * - COMPLETE `BindConfig` → cross-validated against the topology counts and
   *   used VERBATIM (remote addresses taken as-is — no port probe / claim /
   *   registry, since a remote endpoint's port is not this host's to reserve),
   *   with any CLI `--bind-*` overrides layered on top (CLI > file).
   * - PARTIAL override → validated via {@link BindOptionsSchema} and merged over
   *   the resolver's picked defaults (CLI > file > resolver).
   *
   * @param options - The caller options (carries `bind`, `bindConfig`, counts).
   * @returns The resolved bind config.
   */
  async function resolveBind(options: ClusterBuildOptions): Promise<BindConfig> {
    const { bind: cliBind = {} } = options,
      topology: ClusterTopologyOptions = {
        producerCount: options.nodeCount,
        batchOperatorCount: options.batchOperatorCount,
        underwriterCount: options.underwriterCount,
        bindAll: options.bindAll
      },
      bind =
        options.bindConfig == null
          ? await BindConfigProvider.resolve(cliBind, topology)
          : await resolveBindFromFile(options.bindConfig, cliBind, topology)
    assertRemoteOutpostRequiresExternalConfig(bind, options)
    return bind
  }

  /** Classify + merge a `--bind-config` file (complete → verbatim | partial → merged). */
  async function resolveBindFromFile(
    bindConfigFile: string,
    cliBind: BindOptions,
    topology: ClusterTopologyOptions
  ): Promise<BindConfig> {
    const parsed: unknown = JSON.parse(
      await Fsp.readFile(Path.resolve(bindConfigFile), "utf-8")
    )
    if (BindConfigSchemaCodec.check(parsed)) {
      // COMPLETE: cross-validate cardinality, then use verbatim with the CLI
      // `--bind-*` overrides layered on top — remote ports are NOT probed.
      assertBindCardinality(parsed, topology)
      return defaultsDeep({ ...cliBind }, parsed) as BindConfig
    }
    // PARTIAL: validate the override shape, then merge over resolver defaults.
    const fileBind = BindOptionsSchema.parse(parsed) as BindOptions
    return BindConfigProvider.resolve(
      defaultsDeep({ ...cliBind }, fileBind),
      topology
    )
  }

  /** Fail fast when a COMPLETE `--bind-config`'s node counts mismatch the topology. */
  function assertBindCardinality(
    bind: BindConfig,
    topology: ClusterTopologyOptions
  ): void {
    const expect = (label: string, actual: number, want: number): void =>
      Assert.ok(
        actual === want,
        `--bind-config: nodeop.ports.${label} has ${actual} entries but the cluster topology expects ${want}`
      )
    expect(
      "producers",
      bind.nodeop.ports.producers.length,
      topology.producerCount ?? DefaultNodeCount
    )
    expect(
      "batch",
      bind.nodeop.ports.batch.length,
      topology.batchOperatorCount ?? DefaultBatchOperatorCount
    )
    expect(
      "underwriters",
      bind.nodeop.ports.underwriters.length,
      topology.underwriterCount ?? DefaultUnderwriterCount
    )
  }

  /**
   * A remote `anvil`/`solana` bind address requires `--external-outpost-config`
   * — there is no local outpost chain to bootstrap against a remote endpoint.
   *
   * @param bind - The resolved bind config.
   * @param options - The caller options (for `externalOutpostConfig`).
   */
  function assertRemoteOutpostRequiresExternalConfig(
    bind: BindConfig,
    options: ClusterBuildOptions
  ): void {
    const isRemote = (address: string): boolean =>
      address !== Localhost && address !== ListenAllAddress
    const remotes = [
      isRemote(bind.anvil.address) ? "anvil (Ethereum)" : null,
      isRemote(bind.solana.address) ? "solana" : null
    ].filter((entry): entry is string => entry != null)
    Assert.ok(
      remotes.length === 0 || options.externalOutpostConfig != null,
      `--bind-config binds ${remotes.join(" + ")} to a remote address, which requires ` +
        "--external-outpost-config (no local outpost chain is started for a remote endpoint)"
    )
  }

  /**
   * Load + validate an `--external-outpost-config` file (external-outpost mode),
   * resolving its `*File`/`*Files` references to absolute paths relative to the
   * config file's directory. Returns `null` for the standard local bootstrap.
   *
   * @param file - Path to the `ExternalOutpostConfig` JSON (may be omitted).
   * @returns The resolved config, or `null`.
   */
  async function loadExternalOutposts(
    file: string
  ): Promise<ExternalOutpostConfig> {
    if (file == null) {
      return null
    }
    const configFile = Path.resolve(file),
      baseDir = Path.dirname(configFile),
      config = ExternalOutpostConfigSchemaCodec.deserialize(
        await Fsp.readFile(configFile, "utf-8")
      ),
      resolveRef = (ref: string): string =>
        Path.isAbsolute(ref) ? ref : Path.resolve(baseDir, ref)
    return {
      ethereum: {
        addressFile: resolveRef(config.ethereum.addressFile),
        abiFiles: config.ethereum.abiFiles.map(resolveRef),
        chainId: config.ethereum.chainId,
        ...(config.ethereum.liqEthAddressFile != null
          ? { liqEthAddressFile: resolveRef(config.ethereum.liqEthAddressFile) }
          : {})
      },
      solana: {
        idlFile: resolveRef(config.solana.idlFile),
        ...(config.solana.mintsFile != null
          ? { mintsFile: resolveRef(config.solana.mintsFile) }
          : {})
      }
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
   * Serialise `config` to pretty JSON via {@link ClusterConfigSchemaCodec} —
   * zod ENCODE (the `underwriterCollateral` `TokenAmount` bigints project to
   * string int64 inside the schema codec) + `JSON.stringify`.
   *
   * @param config - The config to serialise.
   * @returns The JSON string.
   */
  export function serialize(config: ClusterConfig): string {
    return ClusterConfigSchemaCodec.serialize(config)
  }

  /**
   * Parse + rehydrate a persisted config via {@link ClusterConfigSchemaCodec} —
   * zod DECODE (`underwriterCollateral.amount` restored to a `TokenAmount`;
   * missing `signatureProvider`/`externalOutposts` filled by schema defaults).
   * Does NOT re-claim ports (reload, not resolve) — `run` re-probes via
   * `BindConfigProvider.validate`.
   *
   * @param input - Raw JSON string.
   * @returns The rehydrated config.
   */
  export function deserialize(input: string): ClusterConfig {
    return ClusterConfigSchemaCodec.deserialize(input)
  }

  /** Substitutions for a signature-provider SSM secret-id pattern. */
  export interface SecretIdSubstitutions {
    /** Basename of the cluster path. */
    cluster: string
    /** WIRE account name the key belongs to. */
    account: string
    /** Key type (curve) name. */
    keyType: string
  }

  /**
   * Render an SSM secret id from a pattern with `{cluster}` / `{account}` /
   * `{keyType}` placeholders. An unknown `{placeholder}` fails fast.
   *
   * @param pattern - The secret-id pattern.
   * @param substitutions - The placeholder values.
   * @returns The rendered secret id.
   */
  export function toSecretId(
    pattern: string,
    substitutions: SecretIdSubstitutions
  ): string {
    return pattern.replace(/\{(\w+)\}/g, (_match, key: string) => {
      const value = substitutions[key as keyof SecretIdSubstitutions]
      Assert.ok(
        value != null,
        `toSecretId: unknown placeholder {${key}} in pattern "${pattern}"`
      )
      return value
    })
  }

  /** Builds the {@link KeyGenerator.SignatureProviderSource} for an account's key. */
  export type SignatureProviderSourceFor = (
    account: string,
    keyType: KeyType
  ) => KeyGenerator.SignatureProviderSource

  /**
   * Build the per-key signature-provider source for a cluster's provider config —
   * `KEY` → inline (byte-identical), `SSM` → the region + per-key rendered secret
   * id (via {@link toSecretId}), `KIOD` → the kiod wallet URL. Threaded into the
   * node / operator-daemon `--signature-provider` args so an SSM/KIOD cluster's
   * daemons obtain their keys accordingly. The bios genesis dev key is NOT
   * SSM/KIOD-managed — callers that render it force {@link KeyGenerator.DefaultKeySource}.
   *
   * @param config - The resolved cluster config.
   * @returns A `(account, keyType) => source` builder.
   */
  export function signatureProviderSource(
    config: ClusterConfig
  ): SignatureProviderSourceFor {
    const provider = config.signatureProvider,
      kiodUrl = toURL(
        config.bind.kiod.port,
        toDialAddress(config.bind.kiod.address)
      ),
      cluster = Path.basename(config.clusterPath)
    return (account, keyType) =>
      KeyGenerator.keySource(
        provider,
        provider.type === SignatureProviderType.SSM
          ? toSecretId(provider.ssm.awsSecretIdPattern, {
              cluster,
              account,
              keyType: KeyType[keyType]
            })
          : "",
        kiodUrl
      )
  }
}
