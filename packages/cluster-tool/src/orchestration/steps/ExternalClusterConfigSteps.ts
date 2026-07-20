import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"
import { match } from "ts-pattern"
import type {
  BindConfig,
  ClusterConfig,
  ClusterSignatureProviderConfig,
  ExternalClusterConfig,
  ExternalClusterConfigAccount,
  ExternalOutpostConfig,
  SignatureProviderConfig
} from "@wireio/cluster-tool-shared"
import {
  BindConfigSchemaCodec,
  ClusterFiles,
  ExternalClusterConfigSchemaCodec,
  SignatureProviderType
} from "@wireio/cluster-tool-shared"
import { KeyType } from "@wireio/sdk-core"
import { getLogger } from "../../logging/Logger.js"
import { AnvilProcess } from "../../cluster/processes/AnvilProcess.js"
import {
  ClusterState,
  type ClusterKeysOperatorEntry
} from "../../cluster/ClusterState.js"
import { BindConfigProvider } from "../../config/BindConfigProvider.js"
import { ClusterConfigProvider } from "../../config/ClusterConfigProvider.js"
import { NodeConfig } from "../../config/NodeConfig.js"
import { OperatorDaemonTool } from "../../tools/wire/OperatorDaemonTool.js"
import type { KeyPair, WireFinalizerKeyPair } from "../../types/KeyPair.js"
import { ClusterBuildContext } from "../ClusterBuildContext.js"
import { ClusterBuildPhase } from "../ClusterBuildPhase.js"
import { ClusterBuildPhaseGroup } from "../ClusterBuildPhaseGroup.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../ClusterBuildStep.js"
import { outputKey, type OutputKey } from "../OutputStore.js"
import { verifyStep } from "../StepTools.js"
import { Report } from "../../report/Report.js"

/**
 * The five-stage `create-external-config` orchestration — clone a CREATED local
 * cluster into a deployable external cluster directory (external `BindConfig`
 * merged in) and emit its self-described `ExternalClusterConfig`.
 *
 * Stages (each a Step): **Validate** (cross-check the external bind against the
 * local topology; load it), **Clone** (copy the tree, excluding runtime
 * artifacts), **Rebind** (re-render every file from the merged model — never
 * text-patch), **Emit** (write `external-cluster-config.json`), **Verify** (scan
 * for any stale local bind + round-trip the emitted JSON). Cross-stage data
 * rides `ctx.outputs`; the local cluster's config is `ctx.config`.
 */
export namespace ExternalClusterConfigSteps {
  /** The per-node config + logging filenames re-rendered into the external tree. */
  const NodeConfigFilename = "config.ini"
  const NodeLoggingFilename = "logging.json"

  /** Command-scoped params (the local cluster is `ctx.config`). */
  export interface Params {
    /** The destination external cluster directory (empty/non-existent). */
    externalClusterPath: string
    /** Path to the external `BindConfig` JSON file. */
    externalBindConfigFile: string
  }

  /** The command-supplied params — seeded on `ctx.outputs` before the build runs. */
  export const ParamsKey: OutputKey<Params> = outputKey(
    "externalClusterConfig.params",
    "create-external-config: the external cluster path + external bind-config file"
  )
  /** The validated external `BindConfig` (Validate → Rebind/Emit). */
  export const ExternalBindKey: OutputKey<BindConfig> = outputKey(
    "externalClusterConfig.externalBind",
    "create-external-config: the validated external BindConfig"
  )
  /** The rebound (external-rooted) merged config (Rebind → Emit/Verify). */
  export const MergedConfigKey: OutputKey<ClusterConfig> = outputKey(
    "externalClusterConfig.mergedConfig",
    "create-external-config: the merged, external-rooted ClusterConfig"
  )

  // ── Stage 1: Validate (one verify step per cross-check) ────────────────────

  /**
   * Compose the "Validate" phase — LOAD the external bind config, then run each
   * cross-check as its OWN verify step so every check lands individually in the
   * Report with fail-fast preserved (a failed step aborts the phase before any
   * write). NO availability probing — these are remote addresses.
   *
   * @param group - The enclosing phase group (self-registers on it).
   * @param actor - The Report actor for every step.
   * @param options - Step options applied to every step.
   * @returns The Validate phase.
   */
  export function planValidatePhase<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    group: ClusterBuildPhaseGroup<C>,
    actor: Report.Actor,
    options: ClusterBuildStepOptions
  ): ClusterBuildPhase<C> {
    return ClusterBuildPhase.create<C>(
      group,
      "Validate",
      "Load + cross-validate the external bind config against the local topology",
      [
        planLoadExternalBind(
          actor,
          "load-external-bind",
          "deserialize + store the external bind config",
          options
        ),
        planVerifyProducerCardinality(
          actor,
          "verify-producer-cardinality",
          "producer bind entries match the local topology",
          options
        ),
        planVerifyBatchCardinality(
          actor,
          "verify-batch-cardinality",
          "batch bind entries match the local topology",
          options
        ),
        planVerifyUnderwriterCardinality(
          actor,
          "verify-underwriter-cardinality",
          "underwriter bind entries match the local topology",
          options
        ),
        planVerifyNodeMapping(
          actor,
          "verify-node-mapping",
          "every cluster-state node maps to a bind entry",
          options
        ),
        planVerifyOperatorAccounts(
          actor,
          "verify-operator-accounts",
          "every state operator account is present in cluster-keys",
          options
        ),
        planVerifySolanaDynamicRange(
          actor,
          "verify-solana-dynamic-range",
          "solana dynamicRange first < last",
          options
        ),
        planVerifyNoDuplicatePorts(
          actor,
          "verify-no-duplicate-ports",
          "no duplicate ports across the external bind",
          options
        )
      ]
    )
  }

  /**
   * Plan the LOAD step — deserialize the external `BindConfig` file (structural
   * validation) and store it on `ctx.outputs` for the checks + Rebind/Emit.
   *
   * @param actor - The Report actor.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step options.
   * @returns The load step.
   */
  export function planLoadExternalBind<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, null> {
    return ClusterBuildStep.create<C, null>(
      actor,
      name,
      description,
      options,
      null,
      runLoadExternalBind
    )
  }

  /** Named runner — deserialize the external bind config + store it for downstream steps. */
  export async function runLoadExternalBind<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const externalBind = BindConfigSchemaCodec.deserialize(
      Fs.readFileSync(
        Path.resolve(ctx.outputs.assert(ParamsKey).externalBindConfigFile),
        "utf-8"
      )
    )
    ctx.outputs.set(ExternalBindKey, externalBind)
  }

  /**
   * Plan the producer-cardinality verify step.
   *
   * @param actor - The Report actor.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step options.
   * @returns The verify step.
   */
  export function planVerifyProducerCardinality<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, null> {
    return verifyStep<C>(
      actor,
      name,
      description,
      runVerifyProducerCardinality,
      options
    )
  }

  /** Named runner — producer bind entries match the local node count. */
  export async function runVerifyProducerCardinality<
    C extends ClusterBuildContext
  >(ctx: C, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    assertCount(
      "producers",
      ctx.outputs.assert(ExternalBindKey).nodeop.ports.producers.length,
      ctx.config.nodeCount
    )
  }

  /**
   * Plan the batch-cardinality verify step.
   *
   * @param actor - The Report actor.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step options.
   * @returns The verify step.
   */
  export function planVerifyBatchCardinality<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, null> {
    return verifyStep<C>(
      actor,
      name,
      description,
      runVerifyBatchCardinality,
      options
    )
  }

  /** Named runner — batch bind entries match the local batch-operator count. */
  export async function runVerifyBatchCardinality<
    C extends ClusterBuildContext
  >(ctx: C, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    assertCount(
      "batch",
      ctx.outputs.assert(ExternalBindKey).nodeop.ports.batch.length,
      ctx.config.batchOperatorCount
    )
  }

  /**
   * Plan the underwriter-cardinality verify step.
   *
   * @param actor - The Report actor.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step options.
   * @returns The verify step.
   */
  export function planVerifyUnderwriterCardinality<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, null> {
    return verifyStep<C>(
      actor,
      name,
      description,
      runVerifyUnderwriterCardinality,
      options
    )
  }

  /** Named runner — underwriter bind entries match the local underwriter count. */
  export async function runVerifyUnderwriterCardinality<
    C extends ClusterBuildContext
  >(ctx: C, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    assertCount(
      "underwriters",
      ctx.outputs.assert(ExternalBindKey).nodeop.ports.underwriters.length,
      ctx.config.underwriterCount
    )
  }

  /**
   * Plan the node-mapping verify step (every persisted node ↔ a bind entry).
   *
   * @param actor - The Report actor.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step options.
   * @returns The verify step.
   */
  export function planVerifyNodeMapping<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, null> {
    return verifyStep<C>(actor, name, description, runVerifyNodeMapping, options)
  }

  /** Named runner — every persisted node maps to a bind entry (bios + role-indexed). */
  export async function runVerifyNodeMapping<C extends ClusterBuildContext>(
    ctx: C,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const ports = ctx.outputs.assert(ExternalBindKey).nodeop.ports,
      state = ClusterState.load(ctx.config),
      bindNodeCount =
        1 + ports.producers.length + ports.batch.length + ports.underwriters.length
    Assert.ok(
      state.nodes.length === bindNodeCount,
      `create-external-config: cluster-state has ${state.nodes.length} nodes but the external bind describes ${bindNodeCount}`
    )
  }

  /**
   * Plan the operator-accounts verify step (every state operator ↔ cluster-keys).
   *
   * @param actor - The Report actor.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step options.
   * @returns The verify step.
   */
  export function planVerifyOperatorAccounts<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, null> {
    return verifyStep<C>(
      actor,
      name,
      description,
      runVerifyOperatorAccounts,
      options
    )
  }

  /** Named runner — every state operator account is present in cluster-keys.json. */
  export async function runVerifyOperatorAccounts<C extends ClusterBuildContext>(
    ctx: C,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const state = ClusterState.load(ctx.config),
      keys = ClusterState.loadKeys(ctx.config),
      keyAccounts = new Set(keys.operators.map(operator => operator.account))
    state.nodes
      .flatMap(node =>
        [node.batchOperatorAccount, node.underwriterAccount].filter(
          (account): account is string => account != null
        )
      )
      .forEach(account =>
        Assert.ok(
          keyAccounts.has(account),
          `create-external-config: operator ${account} is in cluster-state but missing from cluster-keys`
        )
      )
  }

  /**
   * Plan the solana dynamic-range verify step (`first` < `last`).
   *
   * @param actor - The Report actor.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step options.
   * @returns The verify step.
   */
  export function planVerifySolanaDynamicRange<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, null> {
    return verifyStep<C>(
      actor,
      name,
      description,
      runVerifySolanaDynamicRange,
      options
    )
  }

  /** Named runner — the external solana `dynamicRange` has `first` < `last`. */
  export async function runVerifySolanaDynamicRange<
    C extends ClusterBuildContext
  >(ctx: C, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const { dynamicRange } = ctx.outputs.assert(ExternalBindKey).solana.ports
    Assert.ok(
      dynamicRange.first < dynamicRange.last,
      `create-external-config: solana dynamicRange first (${dynamicRange.first}) must be < last (${dynamicRange.last})`
    )
  }

  /**
   * Plan the no-duplicate-ports verify step (across the whole external bind).
   *
   * @param actor - The Report actor.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step options.
   * @returns The verify step.
   */
  export function planVerifyNoDuplicatePorts<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, null> {
    return verifyStep<C>(
      actor,
      name,
      description,
      runVerifyNoDuplicatePorts,
      options
    )
  }

  /** Named runner — no port appears twice across the whole external bind config. */
  export async function runVerifyNoDuplicatePorts<C extends ClusterBuildContext>(
    ctx: C,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const allPorts = BindConfigProvider.allPorts(ctx.outputs.assert(ExternalBindKey))
    Assert.ok(
      new Set(allPorts).size === allPorts.length,
      "create-external-config: the external bind config has duplicate ports"
    )
  }

  /** Assert a bind role array's cardinality matches the local topology count. */
  function assertCount(role: string, actual: number, expected: number): void {
    Assert.ok(
      actual === expected,
      `create-external-config: external bind nodeop.ports.${role} has ${actual} entries but the local cluster has ${expected}`
    )
  }

  // ── Stage 2: Clone ─────────────────────────────────────────────────────────

  /**
   * Copy the local cluster tree to the external path, EXCLUDING runtime
   * artifacts (`*.pid`, `logs/`, `reports/`) and preserving `cluster-keys.json`'s
   * 0600 mode. Rebind then re-renders the config files in place.
   *
   * @param actor - The Report actor.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step options.
   * @returns The clone step.
   */
  export function planClone<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, null> {
    return ClusterBuildStep.create<C, null>(
      actor,
      name,
      description,
      options,
      null,
      runClone
    )
  }

  /** Named runner — copy the local tree to the external path (runtime artifacts excluded). */
  export async function runClone<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const localConfig = ctx.config,
      { externalClusterPath } = ctx.outputs.assert(ParamsKey)
    Fs.cpSync(localConfig.clusterPath, externalClusterPath, {
      recursive: true,
      filter: source => {
        const base = Path.basename(source)
        return base !== "logs" && base !== "reports" && !source.endsWith(".pid")
      }
    })
    // cpSync does not reliably carry file mode — re-assert 0600 on the keys file.
    const externalKeysFile = Path.join(
      externalClusterPath,
      Path.relative(localConfig.clusterPath, ClusterState.keysFilePath(localConfig))
    )
    if (Fs.existsSync(externalKeysFile)) Fs.chmodSync(externalKeysFile, 0o600)

    // External-outpost mode: copy the outpost artifact files (which may live
    // OUTSIDE the local tree) INTO the external tree so it stays self-described.
    if (localConfig.externalOutposts != null) {
      const externalDataPath = Path.join(
        externalClusterPath,
        Path.relative(localConfig.clusterPath, localConfig.dataPath)
      )
      copyExternalOutpostFiles(externalDataPath, localConfig.externalOutposts)
    }
  }

  // ── Stage 3: Rebind ────────────────────────────────────────────────────────

  /**
   * Build the merged, external-rooted `ClusterConfig` (local config with `bind` ←
   * the external bind config and every `clusterPath`-rooted path rewritten to the
   * external root) and RE-RENDER every derived file from it (never text-patch):
   * `cluster-config.json`, `genesis.json`, each node's `config.ini` /
   * `logging.json`, and `cluster-state.json`. Stores the merged config.
   *
   * @param actor - The Report actor.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step options.
   * @returns The rebind step.
   */
  export function planRebind<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, null> {
    return ClusterBuildStep.create<C, null>(
      actor,
      name,
      description,
      options,
      null,
      runRebind
    )
  }

  /** Named runner — merge the config to the external root + re-render every file. */
  export async function runRebind<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const localConfig = ctx.config,
      { externalClusterPath } = ctx.outputs.assert(ParamsKey),
      externalBind = ctx.outputs.assert(ExternalBindKey),
      // Remap any path rooted at the local cluster dir onto the external root;
      // host-specific roots (build/ethereum/solana/executables) stay verbatim.
      rootSwap = (path: string): string =>
        path === localConfig.clusterPath ||
        path.startsWith(localConfig.clusterPath + Path.sep)
          ? Path.join(
              externalClusterPath,
              Path.relative(localConfig.clusterPath, path)
            )
          : path,
      mergedConfig: ClusterConfig = {
        ...localConfig,
        clusterPath: externalClusterPath,
        dataPath: rootSwap(localConfig.dataPath),
        walletPath: rootSwap(localConfig.walletPath),
        bind: externalBind,
        report: { ...localConfig.report, path: rootSwap(localConfig.report.path) },
        // external-outpost refs now point at their in-tree copies (Clone put them there).
        externalOutposts:
          localConfig.externalOutposts != null
            ? inTreeExternalOutpost(
                rootSwap(localConfig.dataPath),
                localConfig.externalOutposts
              )
            : null
      }

    await ClusterConfigProvider.save(mergedConfig)
    Fs.writeFileSync(
      ClusterConfigProvider.genesisFile(mergedConfig),
      ClusterConfigProvider.genesisRenderer(mergedConfig).render()
    )
    NodeConfig.plan(mergedConfig).forEach(node => {
      Fs.mkdirSync(node.nodePath, { recursive: true })
      Fs.writeFileSync(
        Path.join(node.nodePath, NodeConfigFilename),
        node.ini.render()
      )
      Fs.writeFileSync(
        Path.join(node.nodePath, NodeLoggingFilename),
        node.logging.render()
      )
    })

    // Re-capture cluster-state.json from the merged model (external ports/paths).
    // A fresh context has an empty OutputStore, so re-derive solanaIdlFile from
    // the external tree (capture would otherwise write null).
    const mergedContext = new ClusterBuildContext(
        mergedConfig,
        getLogger(mergedConfig.report.basename)
      ),
      state = ClusterState.capture(mergedContext),
      solanaIdlFile =
        mergedConfig.externalOutposts != null
          ? mergedConfig.externalOutposts.solana.idlFile
          : Path.join(
              mergedConfig.dataPath,
              OperatorDaemonTool.SolanaIdlSubpath,
              OperatorDaemonTool.SolanaIdlFilename
            )
    ClusterState.save(mergedConfig, {
      ...state,
      solanaIdlFile: Fs.existsSync(solanaIdlFile) ? solanaIdlFile : null
    })

    ctx.outputs.set(MergedConfigKey, mergedConfig)
  }

  // ── Stage 4: Emit ──────────────────────────────────────────────────────────

  /**
   * Emit `external-cluster-config.json` — the fully self-described deployment
   * payload: the external bindings, every operator account's signature providers
   * (reflecting the SOURCE cluster's `signatureProvider.type` — see
   * {@link keyProviderFor}), the depot `epochDurationSec` + genesis path, and the
   * ethereum/solana outpost references (from `config.externalOutposts` when the
   * local cluster was created external, else derived from the cloned data dir).
   *
   * SECRET-BEARING ONLY UNDER `KEY`: a KEY-provider cluster embeds every
   * operator's plaintext `privateKey` (testnet key material by design). Under
   * `SSM` the file carries only `awsSecretId` refs (reconstructed via the same
   * `toSecretId(...)` create used to publish) and under `KIOD` it is
   * material-less — NO plaintext in either. The file is written 0600 regardless:
   * MANDATORY for the KEY case, kept as defense-in-depth for SSM/KIOD.
   *
   * @param actor - The Report actor.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step options.
   * @returns The emit step.
   */
  export function planEmit<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, null> {
    return ClusterBuildStep.create<C, null>(
      actor,
      name,
      description,
      options,
      null,
      runEmit
    )
  }

  /** Named runner — assemble + write `external-cluster-config.json`. */
  export async function runEmit<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const merged = ctx.outputs.assert(MergedConfigKey),
      externalBind = ctx.outputs.assert(ExternalBindKey),
      keys = ClusterState.loadKeys(merged),
      // The provider type + SSM settings are the SOURCE cluster's; SSM secret
      // ids were PutParameter'd at CREATE time under the SOURCE cluster's
      // basename — reconstruct against ctx.config (source), NOT merged (external root).
      provider = ctx.config.signatureProvider,
      cluster = Path.basename(ctx.config.clusterPath),
      solana = solanaSection(merged),
      external: ExternalClusterConfig = {
        bindings: externalBind,
        accounts: {
          operators: keys.operators.map(operator =>
            toAccount(operator, provider, cluster)
          )
        },
        wire: {
          epochDurationSec: merged.epochDurationSec,
          genesisFile: ClusterConfigProvider.genesisFile(merged)
        },
        ethereum: ethereumSection(merged),
        ...(solana != null ? { solana } : {})
      }
    // Secret-bearing (embeds plaintext KEY-provider private keys) — write + pin
    // 0600, mirroring ClusterState.saveKeys / KeysFileMode.
    const externalConfigFile = Path.join(
      merged.clusterPath,
      ClusterFiles.ExternalConfigFilename
    )
    Fs.writeFileSync(
      externalConfigFile,
      ExternalClusterConfigSchemaCodec.serialize(external),
      { mode: 0o600 }
    )
    Fs.chmodSync(externalConfigFile, 0o600)
  }

  /**
   * Map one `cluster-keys.json` operator record to an external-config account —
   * the providers reflect the source cluster's provider type (see
   * {@link keyProviderFor}).
   */
  function toAccount(
    operator: ClusterKeysOperatorEntry,
    provider: ClusterSignatureProviderConfig,
    cluster: string
  ): ExternalClusterConfigAccount {
    const providerFor = (keyPair: KeyPair): SignatureProviderConfig =>
      keyProviderFor(keyPair, operator.account, provider, cluster)
    return {
      accountName: operator.account,
      type: operator.type,
      keyProviders: [
        providerFor(operator.wire),
        ...(operator.bls != null ? [providerFor(operator.bls)] : []),
        ...(operator.ethereum != null ? [providerFor(operator.ethereum)] : []),
        ...(operator.solana != null ? [providerFor(operator.solana)] : [])
      ]
    }
  }

  /**
   * The operator key curves published to SSM at create time
   * (`KeySteps.signatureProviderKeyPublications`: K1 wire / EM ethereum / ED
   * solana — NEVER operator BLS; BLS is a producer-NODE key and external-config
   * emits OPERATORS). The SSM emit branch guards this set so an emitted
   * `awsSecretId` never references a parameter create did not publish.
   */
  const OperatorSsmKeyTypes: readonly KeyType[] = [
    KeyType.K1,
    KeyType.EM,
    KeyType.ED
  ]

  /**
   * Build a signature-provider config from a stored operator key pair, reflecting
   * the SOURCE cluster's provider type:
   * - `KEY`  → inline plaintext `privateKey` (byte-identical to a KEY cluster's keys).
   * - `SSM`  → a region + rendered `awsSecretId` ref (NO private key); the id is
   *   reconstructed DETERMINISTICALLY via the same
   *   `ClusterConfigProvider.toSecretId(pattern, {cluster, account, keyType})`
   *   `KeySteps` PutParameter'd at create time.
   * - `KIOD` → material-less (`publicKey` + BLS proof only); hydration is deferred.
   *
   * A BLS pair carries its `proofOfPossession` in every mode (required by the
   * union). Under `SSM` the key's curve MUST be in {@link OperatorSsmKeyTypes} —
   * an out-of-set curve (e.g. operator BLS) is refused rather than emitted as a
   * dangling ref.
   *
   * @param keyPair - The stored key pair.
   * @param account - The operator account (the secret-id `{account}`).
   * @param provider - The source cluster's signature-provider config.
   * @param cluster - The source cluster label (the secret-id `{cluster}`).
   * @returns The provider entry for this key.
   */
  function keyProviderFor(
    keyPair: KeyPair,
    account: string,
    provider: ClusterSignatureProviderConfig,
    cluster: string
  ): SignatureProviderConfig {
    const base = {
      type: keyPair.type,
      publicKey: keyPair.publicKey,
      ...(keyPair.type === KeyType.BLS
        ? {
            proofOfPossession: (keyPair as WireFinalizerKeyPair).proofOfPossession
          }
        : {})
    }
    return match(provider.type)
      .with(
        SignatureProviderType.KEY,
        (): SignatureProviderConfig => ({
          providerType: SignatureProviderType.KEY,
          ...base,
          privateKey: keyPair.privateKey
        })
      )
      .with(SignatureProviderType.SSM, (): SignatureProviderConfig => {
        const ssm = provider.ssm
        Assert.ok(
          ssm != null,
          "create-external-config: SSM signature provider requires ssm settings"
        )
        Assert.ok(
          OperatorSsmKeyTypes.includes(keyPair.type),
          `create-external-config: operator key ${KeyType[keyPair.type]} is not SSM-published (operators publish K1/EM/ED only) — refusing a dangling SSM ref for ${account}`
        )
        return {
          providerType: SignatureProviderType.SSM,
          ...base,
          awsRegion: ssm.awsRegion,
          awsSecretId: ClusterConfigProvider.toSecretId(ssm.awsSecretIdPattern, {
            cluster,
            account,
            keyType: KeyType[keyPair.type]
          })
        }
      })
      .with(
        SignatureProviderType.KIOD,
        (): SignatureProviderConfig => ({
          providerType: SignatureProviderType.KIOD,
          ...base
        })
      )
      .exhaustive()
  }

  /** Subpath (under the external data dir) for copied external-outpost artifacts. */
  const ExternalOutpostSubpath = "external-outpost"

  /** The in-tree path for a copied external-outpost artifact (self-contained tree). */
  function inTreeExternalOutpostFile(
    externalDataPath: string,
    chain: string,
    sourceFile: string
  ): string {
    return Path.join(
      externalDataPath,
      ExternalOutpostSubpath,
      chain,
      Path.basename(sourceFile)
    )
  }

  /** The external-outpost config with every FILE ref rewritten to its in-tree copy. */
  function inTreeExternalOutpost(
    externalDataPath: string,
    external: ExternalOutpostConfig
  ): ExternalOutpostConfig {
    const inTree = (chain: string, file: string): string =>
      inTreeExternalOutpostFile(externalDataPath, chain, file)
    return {
      ethereum: {
        addressFile: inTree("ethereum", external.ethereum.addressFile),
        abiFiles: external.ethereum.abiFiles.map(file => inTree("ethereum", file)),
        chainId: external.ethereum.chainId,
        ...(external.ethereum.liqEthAddressFile != null
          ? {
              liqEthAddressFile: inTree(
                "ethereum",
                external.ethereum.liqEthAddressFile
              )
            }
          : {})
      },
      solana: {
        idlFile: inTree("solana", external.solana.idlFile),
        ...(external.solana.mintsFile != null
          ? { mintsFile: inTree("solana", external.solana.mintsFile) }
          : {})
      }
    }
  }

  /**
   * Copy an external-outpost config's referenced files INTO the external tree so
   * the external directory stays fully self-described (packageable + portable)
   * even when the originals live outside the local cluster tree.
   *
   * @param externalDataPath - The external cluster's data dir.
   * @param external - The (absolute-ref) external-outpost config.
   */
  function copyExternalOutpostFiles(
    externalDataPath: string,
    external: ExternalOutpostConfig
  ): void {
    const copy = (chain: string, source: string): void => {
      Assert.ok(
        Fs.existsSync(source),
        `create-external-config: external-outpost file not found: ${source}`
      )
      const destination = inTreeExternalOutpostFile(externalDataPath, chain, source)
      Fs.mkdirSync(Path.dirname(destination), { recursive: true })
      Fs.copyFileSync(source, destination)
    }
    copy("ethereum", external.ethereum.addressFile)
    external.ethereum.abiFiles.forEach(file => copy("ethereum", file))
    if (external.ethereum.liqEthAddressFile != null) {
      copy("ethereum", external.ethereum.liqEthAddressFile)
    }
    copy("solana", external.solana.idlFile)
    if (external.solana.mintsFile != null) copy("solana", external.solana.mintsFile)
  }

  /** The ethereum outpost section — from `externalOutposts`, else the cloned data dir. */
  function ethereumSection(merged: ClusterConfig): ExternalOutpostConfig["ethereum"] {
    if (merged.externalOutposts != null) {
      return { ...merged.externalOutposts.ethereum }
    }
    const deploymentsDir = ClusterConfigProvider.ethereumDeploymentsPath(merged),
      abiDir = Path.join(merged.dataPath, OperatorDaemonTool.EthereumAbiSubpath),
      abiFiles = Fs.existsSync(abiDir)
        ? Fs.readdirSync(abiDir)
            .filter(file => file.endsWith(".json"))
            .map(file => Path.join(abiDir, file))
        : [],
      liqEthAddressFile = Path.join(deploymentsDir, "liqeth-addrs.json")
    return {
      addressFile: Path.join(deploymentsDir, "outpost-addrs.json"),
      abiFiles,
      chainId: AnvilProcess.DefaultChainId,
      ...(Fs.existsSync(liqEthAddressFile) ? { liqEthAddressFile } : {})
    }
  }

  /** The solana outpost section — from `externalOutposts`, else the cloned IDL (or none). */
  function solanaSection(
    merged: ClusterConfig
  ): ExternalOutpostConfig["solana"] {
    if (merged.externalOutposts != null) {
      return { ...merged.externalOutposts.solana }
    }
    const idlFile = Path.join(
        merged.dataPath,
        OperatorDaemonTool.SolanaIdlSubpath,
        OperatorDaemonTool.SolanaIdlFilename
      ),
      mintsFile = Path.join(merged.dataPath, "sol-mock-mints.json")
    return Fs.existsSync(idlFile)
      ? { idlFile, ...(Fs.existsSync(mintsFile) ? { mintsFile } : {}) }
      : null
  }

  // ── Stage 5: Verify ────────────────────────────────────────────────────────

  /**
   * Self-validation backstop: scan the external config files for any stale local
   * bind port (one the external bind does NOT also use — the invariant is "no
   * file retains a local bind address/port") and round-trip the emitted
   * `external-cluster-config.json` through its codec.
   *
   * @param actor - The Report actor.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step options.
   * @returns The verify step.
   */
  export function planVerify<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, null> {
    return ClusterBuildStep.create<C, null>(
      actor,
      name,
      description,
      options,
      null,
      runVerify
    )
  }

  /** Every bind address across the five daemons (for the stale-address scan). */
  function bindAddresses(bind: ClusterConfig["bind"]): string[] {
    return [
      bind.kiod.address,
      bind.nodeop.address,
      bind.anvil.address,
      bind.solana.address,
      bind.debuggingServer.address
    ]
  }

  /** Escape a literal for use inside a `RegExp`. */
  function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }

  /** Named runner — scan for any stale local bind port/address + round-trip the config. */
  export async function runVerify<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const localConfig = ctx.config,
      merged = ctx.outputs.assert(MergedConfigKey),
      externalPorts = new Set(BindConfigProvider.allPorts(merged.bind)),
      externalAddresses = new Set(bindAddresses(merged.bind)),
      // Ports/addresses that were local-only and MUST have been rewritten out.
      stalePorts = BindConfigProvider.allPorts(localConfig.bind).filter(
        port => !externalPorts.has(port)
      ),
      staleAddresses = bindAddresses(localConfig.bind).filter(
        address => !externalAddresses.has(address)
      ),
      configFiles = [
        ClusterConfigProvider.configFilePath(merged),
        ClusterState.stateFilePath(merged),
        ClusterConfigProvider.genesisFile(merged),
        Path.join(merged.clusterPath, ClusterFiles.ExternalConfigFilename),
        ...NodeConfig.plan(merged).flatMap(node => [
          Path.join(node.nodePath, NodeConfigFilename),
          Path.join(node.nodePath, NodeLoggingFilename)
        ])
      ]
    configFiles
      .filter(file => Fs.existsSync(file))
      .forEach(file => {
        const text = Fs.readFileSync(file, "utf-8")
        stalePorts.forEach(port => {
          // HEX-safe boundary — a local port must not be flagged as a substring
          // of a larger number (8888 ⊄ 18888) NOR inside a hex key (…a8888b…).
          const boundary = new RegExp(`(?<![0-9a-fA-F])${port}(?![0-9a-fA-F])`)
          Assert.ok(
            !boundary.test(text),
            `create-external-config: ${file} still contains the local bind port ${port}`
          )
        })
        staleAddresses.forEach(address => {
          const boundary = new RegExp(
            `(?<![0-9A-Za-z.:])${escapeRegExp(address)}(?![0-9A-Za-z.:])`
          )
          Assert.ok(
            !boundary.test(text),
            `create-external-config: ${file} still contains the local bind address ${address}`
          )
        })
      })

    // Round-trip the emitted payload through its codec (structural backstop).
    ExternalClusterConfigSchemaCodec.deserialize(
      Fs.readFileSync(
        Path.join(merged.clusterPath, ClusterFiles.ExternalConfigFilename),
        "utf-8"
      )
    )
  }
}
