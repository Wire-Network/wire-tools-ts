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
  type AWSClusterNodeConfig,
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
import { getLogger } from "../logging/Logger.js"
import { LogFileAppender } from "../logging/LogFileAppender.js"
import { Report } from "../report/Report.js"
import type { Renderer } from "../utils/Renderer.js"
import { which } from "../utils/fsUtils.js"
import { keyPairFromPrivate } from "../utils/keyPairUtils.js"
import type {
  KeyPair,
  WireFinalizerKeyPair,
  WireKeyPair
} from "../types/KeyPair.js"
import { Constants } from "../Constants.js"
import { BatchOperatorSchedule } from "./BatchOperatorSchedule.js"
import { BindConfigProvider } from "./BindConfigProvider.js"
import type {
  ClusterBuildOptions,
  LoggingOptions
} from "./ClusterBuildOptions.js"
// Sibling-module cycle (NodeConfig → NodeConfigIniRenderer → here → NodeConfig):
// every reference on both sides is read inside a function body, never at
// module-init, so whichever module loads first the other is complete by the
// time a value is dereferenced.
import { NodeConfig, NodeRole } from "./NodeConfig.js"
import { SSMClientProvider } from "./SSMClientProvider.js"
import { ClusterConfigGenesisRenderer } from "./renderers/ClusterConfigGenesisRenderer.js"

const log = getLogger(__filename)

/** Throw if a required option is missing (fail-fast at the boundary). */
function assertOption<T>(value: T | null, name: string): T {
  Assert.ok(value != null, `ClusterBuildOptions.${name} is required`)
  return value
}

/**
 * Resolve + validate the batch-operator schedule for `options`, returning the
 * roster size. Delegates every invariant to {@link BatchOperatorSchedule.resolve}
 * — the ONE place the shape is derived — so this boundary and the
 * `epoch::setconfig` step can never disagree.
 *
 * Called before {@link ClusterConfigProvider.resolve} touches the binding, so an
 * illegal topology is rejected before a cluster's worth of ports is claimed
 * (and ~15 minutes before `sysio.epoch::schbatchgps` would have reverted).
 *
 * @param options - The caller's topology + epoch overrides.
 * @returns The validated roster size.
 */
function assertBatchOperatorSchedule(options: ClusterBuildOptions): number {
  const {
    batchOperatorCount = ClusterConfigProvider.DefaultBatchOperatorCount,
    operatorsPerEpoch,
    batchOpGroups
  } = options
  BatchOperatorSchedule.resolve({
    batchOperatorCount,
    operatorsPerEpoch,
    batchOpGroups
  })
  return batchOperatorCount
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
    // Roster shape first: it is pure arithmetic, and rejecting here means an
    // illegal topology never claims a cluster's worth of ports (nor holds the
    // host-global bind lock) on its way to failing.
    const batchOperatorCount = assertBatchOperatorSchedule(options),
      buildPath = assertOption(options.buildPath, "buildPath"),
      clusterPath = assertOption(options.clusterPath, "clusterPath"),
      bind = await resolveBind(options),
      executables = await resolveExecutables(buildPath),
      report = resolveReport(options.report, clusterPath),
      logging = resolveLogging(options.logging),
      awsClusterNodeConfig = resolveAWSClusterNodeConfig(
        options.awsClusterNodeConfig
      ),
      signatureProvider = resolveSignatureProvider(
        options.signatureProvider,
        awsClusterNodeConfig
      ),
      externalOutposts = await loadExternalOutposts(
        options.externalOutpostConfig
      )
    assertExternalOutpostTopology(options, externalOutposts)

    return {
      buildPath,
      clusterPath,
      dataPath: Path.join(clusterPath, DataSubpath),
      walletPath: Path.join(clusterPath, WalletSubpath),
      producerCount: options.producerCount ?? DefaultProducerCount,
      nodeCount: options.nodeCount ?? DefaultNodeCount,
      batchOperatorCount,
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
      // Genesis authority = the well-known dev BIOS key pair, matching the
      // long-green bootstrap (the real finalizer policy is set later via
      // bios::setfinalizer). An SSM cluster REPLACES both of these in
      // `resolveWithBiosKeys` — plain `resolve` is the config-only facade and
      // never performs key generation or SSM I/O.
      initialKey: KeyGenerator.BiosK1Key.publicKey,
      initialFinalizerKey: KeyGenerator.BiosBLSKey.publicKey,
      signatureProvider,
      awsClusterNodeConfig,
      externalOutposts,
      debuggingServerEnabled: true,
      enableMockReserves: options.enableMockReserves ?? false
    }
  }

  /**
   * A resolved config PLUS the genesis-time private key material a build needs
   * before ANY step runs. Deliberately NOT a zod/persisted shape: it carries
   * PRIVATE keys and must never reach `cluster-config.json` (only the publics
   * do, as `config.initialKey` / `config.initialFinalizerKey`).
   */
  export interface ClusterConfigWithBiosKeys {
    /** The resolved config; its `initialKey` / `initialFinalizerKey` ARE these keys' publics. */
    config: ClusterConfig
    /** The bios node's block-signing (K1) key — genesis `initial_key`. */
    biosWire: WireKeyPair
    /** The bios node's finality (BLS) key — genesis `initial_finalizer_key`. */
    biosFinalizer: WireFinalizerKeyPair
    /** The bootstrap node owner's account-authority (K1) key. */
    nodeOwnerWire: WireKeyPair
  }

  /**
   * Resolve a config together with its genesis-time key material — the ONE
   * entry point `ClusterBuild.create` uses. The bios keys are GENESIS material:
   * `ClusterManager.launch` writes `genesis.json` (and every node's
   * `config.ini`) BEFORE `build.build()` runs, and both renderers see only a
   * `ClusterConfig` — so the keys have to exist at CONFIG-RESOLUTION time, not
   * in a build phase. The bootstrap node owner's key rides along for the same
   * reason: it is the `roa::newnameduser` account authority AND must be in the
   * kiod wallet before the first `roa::newuser`, which happens in the very first
   * phases.
   *
   * - `KEY` / `KIOD` → the well-known dev bios keys, byte-identical to every
   *   historical cluster: same `genesis.json`, same chain id, same wallet
   *   imports. No generation, no SSM I/O.
   * - `SSM` → each key is ADOPTED from its SSM parameter when one already
   *   exists (so re-creating a cluster keeps its identity), otherwise generated.
   *   A generated `initial_key` changes `genesis.json`, and therefore the CHAIN
   *   ID, versus a dev-key cluster — expected and unavoidable: the genesis
   *   authority is part of the chain's identity.
   *
   * @param options - Caller options.
   * @returns The resolved config plus the bios + node-owner key material.
   */
  export async function resolveWithBiosKeys(
    options: ClusterBuildOptions
  ): Promise<ClusterConfigWithBiosKeys> {
    const config = await resolve(options)
    if (config.signatureProvider.type !== SignatureProviderType.SSM) {
      return {
        config,
        biosWire: KeyGenerator.BiosK1Key,
        biosFinalizer: KeyGenerator.BiosBLSKey,
        nodeOwnerWire: KeyGenerator.BiosK1Key
      }
    }
    // Only K1 + BLS are resolved here, so the EM backend (the one member that
    // consumes `ethereumMnemonic`) is never reached.
    const keyContext: KeyGenerator.Context = {
        clio: config.executables.clio,
        sysUtil: Path.join(config.buildPath, KeyGenerator.SysUtilSubpath),
        ethereumMnemonic: null
      },
      [biosWire, biosFinalizer, nodeOwnerWire] = await Promise.all([
        adoptOrCreateKey(
          config,
          KeyType.K1,
          NodeConfig.BiosName,
          keyContext,
          "bios node block signing (K1) — genesis initial_key"
        ),
        adoptOrCreateKey(
          config,
          KeyType.BLS,
          NodeConfig.BiosName,
          keyContext,
          "bios node finality (BLS) — genesis initial_finalizer_key"
        ),
        adoptOrCreateKey(
          config,
          KeyType.K1,
          Constants.BOOTSTRAP_NODE_OWNER,
          keyContext,
          "bootstrap node owner account authority (K1)"
        )
      ])
    return {
      config: {
        ...config,
        initialKey: biosWire.publicKey,
        initialFinalizerKey: biosFinalizer.publicKey
      },
      biosWire,
      biosFinalizer,
      nodeOwnerWire
    }
  }

  /**
   * Adopt an EXISTING SSM key when the AWS account already owns its parameter,
   * else generate a fresh one — the config-time twin of
   * `KeySteps.adoptOrCreateSignatureProviderKey` (D21), which cannot be used
   * here: it lives in the orchestration layer, and these keys are needed BEFORE
   * any step exists. The secret id comes from the ONE renderer
   * ({@link signatureProviderSource}) and the read spans every replication
   * region, so a divergent parameter fails loudly instead of being adopted.
   * The parameter VALUE is never logged.
   *
   * @param config - The resolved cluster config (SSM signature provider).
   * @param keyType - The curve to resolve.
   * @param account - The key's DURABLE handle — the secret-id `{account}` segment.
   * @param keyContext - Binaries the generation backends need.
   * @param purpose - What the key is for (lands in the keygen `extra` record).
   * @returns The adopted or generated key pair.
   */
  async function adoptOrCreateKey<T extends KeyType>(
    config: ClusterConfig,
    keyType: T,
    account: string,
    keyContext: KeyGenerator.Context,
    purpose: string
  ): Promise<KeyPair<T>> {
    const { awsSecretId } = signatureProviderSource(config)(account, keyType),
      // `resolve` derives `ssm.awsRegions` from `awsClusterNodeConfig.regions`,
      // so a resolved SSM config always names its replication set.
      existing = await SSMClientProvider.getParameterAcrossRegions(
        config.signatureProvider.ssm.awsRegions,
        awsSecretId
      )
    if (existing != null) {
      log.info(
        `ClusterConfigProvider: adopting the existing SSM key ${awsSecretId} (${purpose}) — NOT regenerating`
      )
      return keyPairFromPrivate(keyType, existing)
    }
    log.info(
      `ClusterConfigProvider: no SSM key at ${awsSecretId} — generating ${purpose}`
    )
    return KeyGenerator.create(keyType, keyContext, { purpose })
  }

  /**
   * `clusterPath` has exactly ONE author. A `--cluster-build-options-file`
   * document that carries `clusterPath` AND an EXPLICIT `--cluster-path` / `-d`
   * on the command line is a conflict — the operator has said it twice, and
   * silently letting the flag win hides a stale path in the document.
   *
   * A `WIRE_CLUSTER_PATH` environment value is deliberately NOT a conflict: the
   * document outranks ambient env (that is the whole precedence chain —
   * explicit flags > file > env > defaults), so a shell export can never be the
   * "second author".
   *
   * Called by the CLI, which is the only layer that can see whether the flag was
   * EXPLICIT (a yargs `default` seeded from the very document under test is
   * indistinguishable from an operator-supplied value once parsed). It lives
   * here, beside {@link resolve}'s other option-source invariants, so both
   * exclusions have one home.
   *
   * @param fileOptions - The loaded build-options document (`null` when no file was given).
   * @param explicitClusterPath - Whether `--cluster-path` / `-d` appeared on the raw command line.
   * @throws When both sources author `clusterPath`.
   */
  export function assertClusterPathSource(
    fileOptions: ClusterBuildOptions,
    explicitClusterPath: boolean
  ): void {
    Assert.ok(
      fileOptions?.clusterPath == null || !explicitClusterPath,
      `clusterPath is authored twice: the --cluster-build-options-file document sets "clusterPath" (${fileOptions?.clusterPath}) AND an explicit --cluster-path/-d was passed. Drop one. ` +
        "(A WIRE_CLUSTER_PATH environment value is NOT a conflict — the document outranks ambient env.)"
    )
  }

  /**
   * External-outpost mode and underwriters are mutually exclusive: an external
   * cluster's ETH + SOL outposts already run on real chains, so there is no
   * local outpost for an underwriter to bond collateral on or to underwrite
   * against — a non-zero underwriter count would provision accounts and start
   * daemons that can never reach ACTIVE.
   *
   * The check is on the EFFECTIVE count, not on whether the option was passed:
   * an OMITTED `underwriterCount` resolves to {@link DefaultUnderwriterCount}
   * (and the CLI seeds its own default of 1), so external mode requires an
   * EXPLICIT `--underwriter-count 0`. The message distinguishes the two causes
   * because their remedies read differently — "you asked for N" vs "you omitted
   * it and got the default".
   *
   * @param options - The caller's options (its `underwriterCount`, if any).
   * @param externalOutposts - The loaded external-outpost config, or `null` for local mode.
   * @throws When external mode is combined with a non-zero effective underwriter count.
   */
  function assertExternalOutpostTopology(
    options: ClusterBuildOptions,
    externalOutposts: ExternalOutpostConfig
  ): void {
    if (externalOutposts == null) {
      return
    }
    const { underwriterCount = DefaultUnderwriterCount } = options,
      cause =
        options.underwriterCount == null
          ? `underwriterCount was omitted, which defaults to ${DefaultUnderwriterCount}`
          : `underwriterCount was set to ${options.underwriterCount}`
    Assert.ok(
      underwriterCount === 0,
      `externalOutposts (--external-outpost-config) requires 0 underwriters, but ${cause}. ` +
        "An external cluster has no local outpost to bond underwriter collateral on — pass an EXPLICIT --underwriter-count 0."
    )
  }

  /**
   * Normalize + validate the caller's AWS placement: `null` when unset,
   * otherwise a config whose `regions` names at least one region (every secret
   * is replicated to EVERY region — there is no primary).
   *
   * @param options - The caller's AWS cluster-node config (may be omitted).
   * @returns The validated config, or `null`.
   */
  function resolveAWSClusterNodeConfig(
    options: AWSClusterNodeConfig
  ): AWSClusterNodeConfig {
    if (options == null) {
      return null
    }
    Assert.ok(
      options.regions?.length > 0,
      "awsClusterNodeConfig.regions must name at least one AWS region (every secret is replicated to all of them)"
    )
    // Explicit `null` (not absence): the slot is persisted to cluster-config.json,
    // where an `undefined` would DROP the key on serialize.
    return { ...options, ssm: options.ssm ?? null }
  }

  /**
   * Resolve the cluster signature-provider config: default {@link
   * SignatureProviderType.KEY}, validate that SSM settings are present iff the
   * type is `SSM`, and DERIVE the SSM replication regions from
   * `awsClusterNodeConfig.regions` (its one author).
   *
   * @param options - Caller signature-provider options (may be omitted).
   * @param awsClusterNodeConfig - The resolved AWS placement (required under SSM).
   * @returns The resolved, validated config.
   */
  function resolveSignatureProvider(
    options: ClusterSignatureProviderOptions,
    awsClusterNodeConfig: AWSClusterNodeConfig
  ): ClusterSignatureProviderConfig {
    const { type = SignatureProviderType.KEY, ssm = null } = options ?? {}
    Assert.ok(
      type !== SignatureProviderType.SSM || ssm != null,
      "signatureProvider.ssm (awsSecretIdPattern) is required when type is SSM"
    )
    Assert.ok(
      ssm == null || type === SignatureProviderType.SSM,
      "signatureProvider.ssm is only valid when type is SSM"
    )
    Assert.ok(
      type !== SignatureProviderType.SSM || awsClusterNodeConfig != null,
      "awsClusterNodeConfig is required when signatureProvider.type is SSM (it sources the secret-id {cluster} segment and the replication regions)"
    )
    // The region set has exactly ONE author — name BOTH sources so the operator
    // knows which one to delete.
    Assert.ok(
      ssm?.awsRegions == null || awsClusterNodeConfig == null,
      "signatureProvider.ssm.awsRegions and awsClusterNodeConfig.regions both author the SSM region set — author awsClusterNodeConfig.regions ONLY (signatureProvider.ssm.awsRegions is derived from it)"
    )
    return {
      type,
      ssm:
        ssm == null
          ? null
          : { ...ssm, awsRegions: awsClusterNodeConfig.regions }
    }
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
    /** The AWS account the cluster runs in (`awsClusterNodeConfig.account`). */
    cluster: string
    /** The key's DURABLE handle — an operator handle (`batchop.a`) or a node name (`node_00`). */
    account: string
    /** Key type (curve) name. */
    keyType: string
    /** The OPTIONAL `{version}` token's value — absent unless the pattern uses it. */
    version?: string
  }

  /**
   * Render an SSM secret id from a pattern with `{cluster}` / `{account}` /
   * `{keyType}` / `{version}` placeholders. A placeholder that is unknown — or
   * known but UNFILLED (the optional `{version}` with no value supplied) — fails
   * fast, so a pattern authoring `{version}` throws at plan time rather than
   * publishing to a half-rendered id.
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
        `toSecretId: unknown or unfilled placeholder {${key}} in pattern "${pattern}"`
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
   * The cluster's AWS account name — the secret-id `{cluster}` value. Fails fast
   * when an SSM cluster carries no `awsClusterNodeConfig` ({@link resolve}
   * enforces it, but a hand-edited `cluster-config.json` can still omit it).
   *
   * @param config - The cluster configuration.
   * @returns The AWS account name.
   */
  function assertAWSAccountName(
    config: ClusterConfig
  ): AWSClusterNodeConfig["account"] {
    Assert.ok(
      config.awsClusterNodeConfig != null,
      "ClusterConfigProvider: an SSM signature provider requires awsClusterNodeConfig (the secret-id {cluster} source)"
    )
    return config.awsClusterNodeConfig.account
  }

  /**
   * Build the per-key signature-provider source for a cluster's provider config —
   * `KEY` → inline (byte-identical), `SSM` → the per-key rendered secret id (via
   * {@link toSecretId}; REGION-LESS — the depot plugin resolves the region from
   * the AWS environment), `KIOD` → the kiod wallet URL. Threaded into the node /
   * operator-daemon `--signature-provider` args so an SSM/KIOD cluster's daemons
   * obtain their keys accordingly. The bios genesis dev key is NOT SSM/KIOD-managed
   * — callers that render it force {@link KeyGenerator.DefaultKeySource}.
   *
   * @param config - The resolved cluster config.
   * @returns A `(account, keyType) => source` builder.
   */
  /**
   * Resolve an identity label to the label whose SSM parameter actually holds
   * its keys — identity and parameter are NOT one-to-one.
   *
   * A producer ACCOUNT signs with its hosting NODE's key set:
   * `runProducerMaterialization` hands the account the node's K1 + BLS objects,
   * deliberately shared by every producer account that node hosts. That pair is
   * therefore published ONCE, under the node name, and every account signing
   * with it resolves the same parameter. Publishing per account would write the
   * SAME private key under N ids — N rotation points for one key, and no
   * cross-id divergence check exists. Every other identity (nodes, the genesis
   * identity, the bootstrap node owner, batch operators, underwriters)
   * publishes under its own label and passes through unchanged.
   *
   * This is the ONE home for that mapping. Splitting it across consumers is
   * exactly what shipped `/wire/<account>/defproducera/{K1,BLS}` refs into
   * `cluster-keys.json` while the emitted external config carried the correct
   * node-keyed id for the very same key.
   *
   * @param config - The resolved cluster config.
   * @returns A resolver from an identity label to its publication label.
   */
  export function publicationLabelFor(
    config: ClusterConfig
  ): (label: string) => string {
    const hostingNode = new Map(
      NodeConfig.plan(config)
        .filter(node => node.role === NodeRole.producer)
        .flatMap(node =>
          node.producers.map((producer): [string, string] => [
            producer,
            node.name
          ])
        )
    )
    return label => hostingNode.get(label) ?? label
  }

  export function signatureProviderSource(
    config: ClusterConfig
  ): SignatureProviderSourceFor {
    const provider = config.signatureProvider,
      // Identity → parameter, resolved HERE so no consumer can render an id the
      // walker never published (see `publicationLabelFor`).
      publicationLabel = publicationLabelFor(config),
      kiodUrl = toURL(
        config.bind.kiod.port,
        toDialAddress(config.bind.kiod.address)
      )
    return (account, keyType) =>
      KeyGenerator.keySource(
        provider,
        provider.type === SignatureProviderType.SSM
          ? toSecretId(provider.ssm.awsSecretIdPattern, {
              cluster: assertAWSAccountName(config),
              account: publicationLabel(account),
              keyType: KeyType[keyType],
              version: provider.ssm.version
            })
          : "",
        kiodUrl
      )
  }
}
