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
  ClusterDeploymentKind,
  ClusterFiles,
  ExternalClusterConfigSchemaCodec,
  SignatureProviderType
} from "@wireio/cluster-tool-shared"
import { KeyType } from "@wireio/sdk-core"
import { getValue } from "@wireio/shared"
import { Constants } from "../../Constants.js"
import { getLogger } from "../../logging/Logger.js"
import { AnvilProcess } from "../../cluster/processes/AnvilProcess.js"
import {
  ClusterState,
  type ClusterKeysOperatorEntry
} from "../../cluster/ClusterState.js"
import { BindConfigProvider } from "../../config/BindConfigProvider.js"
import { ClusterConfigProvider } from "../../config/ClusterConfigProvider.js"
import { DaemonConfig } from "../../config/DaemonConfig.js"
import { NodeConfig } from "../../config/NodeConfig.js"
import { StartScriptSteps } from "./StartScriptSteps.js"
import { OperatorDaemonTool } from "../../tools/wire/OperatorDaemonTool.js"
import { ExternalOutpostSteps } from "./ExternalOutpostSteps.js"
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
import { KeySteps } from "./KeySteps.js"
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
  /** The per-node logging filename re-rendered into the external tree
   *  (its `config.ini` sibling is `ClusterFiles.NodeConfigFilename`). */
  const NodeLoggingFilename = "logging.json"

  /** Directory basenames excluded from the external clone (runtime artifacts). */
  const CloneExcludedDirnames: ReadonlySet<string> = new Set(["logs", "reports"])
  /** Pidfile suffix excluded from the external clone. */
  const PidFileSuffix = ".pid"

  /**
   * Whether a cluster-tree entry should be copied into the external clone.
   * Excludes runtime artifacts (`logs/`, `reports/`, `*.pid`) AND non-regular
   * inodes that `Fs.cpSync` cannot copy — unix sockets (`kiod.sock`, the solana
   * ledger's `admin.rpc`), FIFOs, and devices. `assertClusterStopped` only
   * checks pidfiles, so a cleanly-stopped cluster can still leave stale socket
   * inodes on disk; skipping them here keeps the clone from throwing an
   * `ERR_FS_CP_*` partway through.
   * @param source - Absolute path of the candidate entry (from `cpSync`'s filter).
   * @returns `true` to copy the entry, `false` to skip it (and its subtree when a directory).
   */
  function isClonableEntry(source: string): boolean {
    const base = Path.basename(source)
    if (CloneExcludedDirnames.has(base) || source.endsWith(PidFileSuffix)) return false
    const stats = Fs.lstatSync(source)
    return (
      !stats.isSocket() &&
      !stats.isFIFO() &&
      !stats.isBlockDevice() &&
      !stats.isCharacterDevice()
    )
  }

  /** Command-scoped params (the local cluster is `ctx.config`). */
  export interface Params {
    /** The destination external cluster directory (empty/non-existent). */
    externalClusterPath: string
    /** Path to the external `BindConfig` JSON file. */
    externalBindConfigFile: string
    /** When true, disable the OPP debugging server in the emitted external
     *  cluster — drops the sink plugin + `--ext-debugging-server` from the
     *  operator daemons and skips starting the server. */
    noDebuggingServer?: boolean
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
          "every state operator label is present in cluster-keys",
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

  /** Named runner — every state operator label is present in cluster-keys.json. */
  export async function runVerifyOperatorAccounts<C extends ClusterBuildContext>(
    ctx: C,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const state = ClusterState.load(ctx.config),
      keys = ClusterState.loadKeys(ctx.config),
      keyLabels = new Set(keys.operators.map(operator => operator.label))
    state.nodes
      .flatMap(node =>
        [node.batchOperatorLabel, node.underwriterLabel].filter(
          (label): label is string => label != null
        )
      )
      .forEach(label =>
        Assert.ok(
          keyLabels.has(label),
          `create-external-config: operator ${label} is in cluster-state but missing from cluster-keys`
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

  /**
   * Named runner — no HOST binds the same port twice.
   *
   * Scoped per host, not globally: an external cluster puts every nodeop on its
   * own machine, so all 43 of them correctly bind the standard `8888`/`9876`.
   * A global-uniqueness check calls that a collision and makes a valid
   * multi-host deployment unrepresentable — it rejected a correct 43-identity
   * bind config on 2026-08-04, after the bootstrap itself had fully succeeded.
   */
  export async function runVerifyNoDuplicatePorts<C extends ClusterBuildContext>(
    ctx: C,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const bindings = BindConfigProvider.allPortBindings(
        ctx.outputs.assert(ExternalBindKey)
      ),
      duplicates = bindings.filter(
        (binding, index) => bindings.indexOf(binding) !== index
      )
    Assert.ok(
      duplicates.length === 0,
      `create-external-config: the external bind config binds the same port twice on one host: ${[...new Set(duplicates)].join(", ")}`
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
      filter: isClonableEntry
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
      { externalClusterPath, noDebuggingServer } = ctx.outputs.assert(ParamsKey),
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
            : null,
        debuggingServerEnabled: noDebuggingServer ? false : localConfig.debuggingServerEnabled,
        // This tree IS the production-shaped one (SHARED-25 AC#4): stamping it
        // here — before the cluster-config.json write below, and therefore
        // before the ini re-render and `emitStartScripts` read it back — is what
        // drops `trace_api_plugin` from its bios / producer nodes.
        deploymentKind: ClusterDeploymentKind.external
      }

    await ClusterConfigProvider.save(mergedConfig)
    Fs.writeFileSync(
      ClusterConfigProvider.genesisFile(mergedConfig),
      ClusterConfigProvider.genesisRenderer(mergedConfig).render()
    )
    NodeConfig.plan(mergedConfig).forEach(node => {
      Fs.mkdirSync(node.nodePath, { recursive: true })
      Fs.writeFileSync(
        Path.join(node.nodePath, ClusterFiles.NodeConfigFilename),
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

    // Re-render EVERY daemon's start.sh against the merged (external) model —
    // not just the per-node files above. `writeAll` DELETES the cloned scripts
    // first: Clone copies the local tree wholesale (excluding only
    // logs/reports/*.pid), so a daemon the external model drops (anvil and the
    // validator under external-outpost mode) would otherwise keep its
    // LOCAL-port script, which the Verify scan cannot flag because it never
    // enumerates it.
    //
    // A node's argv carries its signing providers, so the operators must be
    // resolvable — and THIS context's keyStore is empty (a fresh context has an
    // empty OutputStore). Rehydrate it from the cloned `cluster-keys.json`
    // exactly as `ClusterManager.run` does before it resolves operators; a
    // cluster whose keys are absent simply gets no scripts rather than failing
    // the rebind.
    await emitStartScripts(mergedContext, mergedConfig, signal)

    ctx.outputs.set(MergedConfigKey, mergedConfig)
  }

  /**
   * The materialized ETH outpost address map — the artifact whose presence
   * proves the outpost deploy published its results into this tree.
   */
  const ExternalOutpostAddressFilename = "outpost-addrs.json"

  /**
   * Re-render EVERY daemon's `start.sh` against the merged (external) model.
   *
   * Two prerequisites make a node's argv resolvable, and a FRESH context has
   * neither — its `OutputStore` and `keyStore` are both empty:
   *
   * 1. **Key material.** A producing node's argv carries its signature
   *    providers, resolved from `ctx.keyStore`. Rehydrated from the cloned
   *    `cluster-keys.json` exactly as `ClusterManager.run` does.
   * 2. **Operator daemon artifacts.** An operator node's argv carries its OPP
   *    daemon args, which assert `OperatorDaemonArtifactsKey`. `run` publishes
   *    those first, branching on outpost mode — the external arm reads only the
   *    cluster tree, the local arm reads the wire-ethereum tree.
   *
   * Either prerequisite may be genuinely absent (a cluster cloned before its
   * outposts deployed, unreadable keys). That is NOT fatal to the rebind: the
   * scripts are SKIPPED with a warning, because emitting a node script without
   * its signing providers or daemon args would ship a script that looks right
   * and starts a misconfigured daemon.
   *
   * @param ctx - The merged-model context (mutated: keyStore + outputs filled).
   * @param config - The merged cluster config.
   * @param signal - Abort signal.
   */
  async function emitStartScripts(
    ctx: ClusterBuildContext,
    config: ClusterConfig,
    signal: AbortSignal
  ): Promise<void> {
    const log = getLogger(__filename)

    // DELETE FIRST, unconditionally. Clone copied every local `start.sh` into
    // this tree; if the render below is skipped, leaving them behind is the
    // WORST outcome — they carry local ports and, under a KEY-mode source
    // cluster, the local inline signing keys the external model exists to
    // replace with `SSM:` refs. No scripts is recoverable; wrong scripts are
    // not.
    //
    // `writeAll` sweeps again on the success path. That is NOT redundant: this
    // copy is the only one that runs when a prerequisite below is missing, and
    // `writeAll`'s is the only one that runs on the `create` path. Removing
    // either re-opens a hole.
    DaemonConfig.existingStartScriptFiles(
      config.dataPath,
      Fs.existsSync,
      Fs.readdirSync as (path: string) => string[]
    ).forEach(file => Fs.rmSync(file, { force: true }))

    // Keys may be genuinely absent (a tree cloned before provisioning) — that
    // is a skip, not a failure. An artifact-publish throw is NOT expected and
    // is left to propagate.
    const keys = getValue(
      () => ClusterState.loadKeys(config),
      null,
      error =>
        log.warn(
          `create-external-config: start scripts skipped — cluster keys unreadable: ${error instanceof Error ? error.message : String(error)}`
        )
    )
    if (keys == null) return
    ClusterState.rehydrate(ctx.keyStore, keys)

    // An operator node's argv carries its OPP daemon args, which need the
    // outpost deploy artifacts. A tree cloned BEFORE those were published
    // (synthetic fixtures, a cluster whose outposts never deployed) simply has
    // none — that is a legitimate skip, PRE-CHECKED rather than caught, so a
    // genuine publication failure still propagates instead of being downgraded
    // to a warning.
    const addressFile = Path.join(
      ClusterConfigProvider.ethereumDeploymentsPath(config),
      ExternalOutpostAddressFilename
    )
    if (!Fs.existsSync(addressFile)) {
      log.warn(
        `create-external-config: start scripts skipped — outpost artifacts absent (${addressFile})`
      )
      return
    }
    // BOTH arms are reachable, and the LOCAL one is the common case: a plain
    // local cluster cloned to external has `externalOutposts == null` (the
    // field is set only when the SOURCE cluster was itself external-outpost),
    // so it takes `runArtifactPreparation`. Verified on a real
    // create-external-config run, which logged that arm's
    // "[operator-daemon] artifacts ready" line.
    await (config.externalOutposts != null
      ? ExternalOutpostSteps.runPublishArtifacts(ctx, null, signal)
      : OperatorDaemonTool.runArtifactPreparation(ctx, null, signal))
    StartScriptSteps.writeAll(config, StartScriptSteps.resolveSources(ctx))
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
      // ids were PutParameter'd at CREATE time under the SOURCE cluster's AWS
      // account — reconstruct against ctx.config (source), NOT merged (external root).
      provider = ctx.config.signatureProvider,
      // What create ACTUALLY published, from the walker that published it — the
      // emitted refs are those rows verbatim, so a ref can never name a
      // parameter that does not exist. Empty under KEY / KIOD.
      lookup = ssmPublicationLookup(ctx.config),
      solana = solanaSection(merged),
      external: ExternalClusterConfig = {
        bindings: externalBind,
        accounts: {
          operators: keys.operators.map(operator =>
            toAccount(operator, provider, lookup)
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
    lookup: SSMPublicationLookup
  ): ExternalClusterConfigAccount {
    // The SSM secret id is keyed by the DURABLE handle (what `KeySteps`
    // PutParameter'd); `accountName` is the ON-CHAIN name the deployed daemon
    // acts as. Two different values — do not collapse them.
    const providerFor = (keyPair: KeyPair): SignatureProviderConfig =>
      keyProviderFor(keyPair, operator.publicationLabel, provider, lookup)
    return {
      accountName: operator.account,
      type: operator.type,
      keyProviders: [
        providerFor(operator.wire),
        ...(operator.wireFinalizer != null
          ? [providerFor(operator.wireFinalizer)]
          : []),
        ...(operator.ethereum != null ? [providerFor(operator.ethereum)] : []),
        ...(operator.solana != null ? [providerFor(operator.solana)] : [])
      ]
    }
  }

  /**
   * Every key create PUBLISHED to SSM, indexed by `<label>/<KeyType>` — the ONE
   * authority for "does this parameter exist", built from the SAME
   * {@link KeySteps.signatureProviderKeyPublications} walker that wrote them.
   */
  type SSMPublicationLookup = (
    label: string,
    keyType: KeyType
  ) => KeySteps.SignatureProviderKeyPublication

  /** Separator for the `<label>/<KeyType>` publication-index key. */
  const PublicationKeySeparator = "/"

  /** The publication-index key for one identity's curve. */
  function publicationKey(label: string, keyType: KeyType): string {
    return [label, KeyType[keyType]].join(PublicationKeySeparator)
  }

  /**
   * Resolve an identity's curve to the publication create wrote for it; yields
   * nothing under KEY / KIOD (nothing was published, and nothing consults it).
   *
   * Deriving the covered set — rather than re-stating a curve list at the emit
   * site — is what makes the guard true by construction. The operator map is NOT
   * homogeneous: batch operators and underwriters publish K1/EM/ED, the genesis
   * identity (`node_bios`) publishes K1/BLS, and the bootstrap node owner
   * publishes K1 alone. A hand-maintained "operators publish K1/EM/ED" set is
   * right for the first class and wrong for the other two — it refused the
   * genesis identity's BLS, a parameter create had genuinely published, and
   * failed every SSM `create-external-config` at the Emit stage.
   *
   * @param config - The SOURCE cluster's resolved config.
   * @returns A resolver from `(identity label, curve)` to its publication.
   */
  function ssmPublicationLookup(config: ClusterConfig): SSMPublicationLookup {
    return match(config.signatureProvider.type)
      .with(SignatureProviderType.SSM, (): SSMPublicationLookup => {
        Assert.ok(
          config.awsClusterNodeConfig != null,
          "create-external-config: SSM signature provider requires awsClusterNodeConfig (the secret-id {cluster} source)"
        )
        // Callers pass the RECORDED `publicationLabel`, so this is a plain
        // lookup — no mapping lives here. Emit deriving its own producer→node
        // relationship is what made `cluster-keys.json` and the emitted config
        // disagree about the same key.
        const index = new Map(
          KeySteps.signatureProviderKeyPublications(config).map(row => [
            publicationKey(row.label, row.keyType),
            row
          ])
        )
        return (label, keyType) => index.get(publicationKey(label, keyType))
      })
      .otherwise((): SSMPublicationLookup => () => undefined)
  }

  /**
   * Build a signature-provider config from a stored operator key pair, reflecting
   * the SOURCE cluster's provider type:
   * - `KEY`  → inline plaintext `privateKey` (byte-identical to a KEY cluster's keys).
   * - `SSM`  → the replication regions + `awsSecretId` taken VERBATIM from the
   *   publication row create wrote (NO private key), so the emitted ref is the
   *   published parameter by construction rather than by two render sites
   *   agreeing.
   * - `KIOD` → material-less (`publicKey` + BLS proof only); hydration is deferred.
   *
   * A BLS pair carries its `proofOfPossession` in every mode (required by the
   * union). Under `SSM` the `(label, curve)` MUST appear in
   * {@link ssmPublicationIndex} — an unpublished pair is refused rather than
   * emitted as a dangling ref.
   *
   * @param keyPair - The stored key pair.
   * @param label - The operator label (the secret-id `{account}`).
   * @param provider - The source cluster's signature-provider config.
   * @param lookup - Resolves an identity's curve to the publication create
   *   wrote for it; yields nothing under KEY / KIOD, where it is unused.
   * @returns The provider entry for this key.
   */
  function keyProviderFor(
    keyPair: KeyPair,
    label: string,
    provider: ClusterSignatureProviderConfig,
    lookup: SSMPublicationLookup
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
        Assert.ok(
          provider.ssm != null,
          "create-external-config: SSM signature provider requires ssm settings"
        )
        const published = lookup(label, keyPair.type)
        Assert.ok(
          published != null,
          `create-external-config: ${label} key ${KeyType[keyPair.type]} is not SSM-published — create wrote no such parameter; refusing a dangling SSM ref`
        )
        return {
          providerType: SignatureProviderType.SSM,
          ...base,
          awsRegions: published.awsRegions,
          awsSecretId: published.secretId
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

  /**
   * The external-outpost config with every FILE ref rewritten to its in-tree
   * copy — and EVERY non-file field carried through untouched.
   *
   * The carry-through is a SPREAD, not a field list. Re-stating the non-file
   * fields silently DROPPED any that the list had not been extended for: an
   * authoritative `rpcUrl` (a real outpost endpoint no bind config can express)
   * vanished from the merged config, so the rebound daemon scripts fell back to
   * the bind-derived URL and a published tree dialed a local anvil that does not
   * exist on the deploy host. Only the file refs are overridden here; the
   * optional ones stay conditional so an ABSENT ref is not re-introduced.
   */
  function inTreeExternalOutpost(
    externalDataPath: string,
    external: ExternalOutpostConfig
  ): ExternalOutpostConfig {
    const inTree = (chain: string, file: string): string =>
      inTreeExternalOutpostFile(externalDataPath, chain, file)
    return {
      ethereum: {
        ...external.ethereum,
        addressFile: inTree("ethereum", external.ethereum.addressFile),
        abiFiles: external.ethereum.abiFiles.map(file => inTree("ethereum", file)),
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
        ...external.solana,
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
      addressFile: Path.join(deploymentsDir, ExternalOutpostAddressFilename),
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

  /**
   * Every bind address across the five daemons — plus each nodeop's per-node
   * advertise address, when bound (multi-host mesh) — for the stale-address scan.
   */
  function bindAddresses(bind: ClusterConfig["bind"]): string[] {
    const nodeopPorts = bind.nodeop.ports,
      advertiseAddresses = [
        nodeopPorts.bios,
        ...nodeopPorts.producers,
        ...nodeopPorts.batch,
        ...nodeopPorts.underwriters
      ]
        .map(ports => ports.advertiseAddress)
        .filter(address => address != null)
    return [
      bind.kiod.address,
      bind.nodeop.address,
      bind.anvil.address,
      bind.solana.address,
      bind.debuggingServer.address,
      ...advertiseAddresses
    ]
  }

  /** Escape a literal for use inside a `RegExp`. */
  function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }

  /**
   * The persisted `ClusterConfig` field holding
   * {@link Constants.CHAIN_STATE_DB_SIZE_MB_OPTION}'s value — the second (and
   * only other) spelling a scanned file carries it under, in
   * `cluster-config.json`. Typed `keyof ClusterConfig` so a field rename fails
   * the build instead of silently un-masking the value.
   */
  const ChainStateDbSizeMbField: keyof ClusterConfig = "chainStateDbSizeMb"

  /**
   * `text` with the chain-state DB SIZE's OWN value blanked out — nothing else.
   *
   * That size is an operator-chosen MEGABYTE count, not an endpoint, and it now
   * rides every emitted `start.sh` (as `--chain-state-db-size-mb <N>`) plus the
   * rebound `cluster-config.json`. A legitimate `N` that happens to equal a
   * stale local bind port — 32768 sits inside the Linux ephemeral range — would
   * otherwise hard-fail Verify claiming the file "still contains the local bind
   * port", about a number that was never a port.
   *
   * The masking is POSITIONAL, not by value: only the digits this setting
   * introduces are removed, so the very same number occurring anywhere else in
   * the same file still fails the scan. The separator run covers both carriers —
   * the renderer puts every argv word on its own quoted continuation line
   * (`'--chain-state-db-size-mb' \` ⏎ `  '32768' \`), while JSON writes
   * `"chainStateDbSizeMb": 32768`.
   *
   * @param text - A scanned file's text, exactly as read.
   * @returns The same text with that one value removed.
   */
  function maskChainStateDbSize(text: string): string {
    const introducers = [
        `--${Constants.CHAIN_STATE_DB_SIZE_MB_OPTION}`,
        ChainStateDbSizeMbField
      ]
        .map(escapeRegExp)
        .join("|"),
      // Quote/whitespace/backslash/colon run between the flag-or-key and its
      // value — never a digit, so the match cannot slide onto another token.
      separator = `['"]?[\\s\\\\'":]*`
    return text.replace(
      new RegExp(`((?:${introducers})${separator})[0-9]+`, "g"),
      "$1"
    )
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
          Path.join(node.nodePath, ClusterFiles.NodeConfigFilename),
          Path.join(node.nodePath, NodeLoggingFilename)
        ]),
        // EVERY emitted start.sh — enumerated from the TREE, not from the
        // model, so a script the external model no longer plans is still
        // scanned rather than silently skipped.
        ...DaemonConfig.existingStartScriptFiles(
          merged.dataPath,
          Fs.existsSync,
          Fs.readdirSync as (path: string) => string[]
        )
      ]
    configFiles
      .filter(file => Fs.existsSync(file))
      .forEach(file => {
        // Scanned with the chain-state DB SIZE's own value masked out: it is an
        // operator-chosen megabyte count, and one that happens to equal a stale
        // local port would otherwise be reported as an un-rebound endpoint.
        const text = maskChainStateDbSize(Fs.readFileSync(file, "utf-8"))
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
