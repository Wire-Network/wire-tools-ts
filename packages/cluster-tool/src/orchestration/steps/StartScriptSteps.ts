import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"
import type { ClusterConfig } from "@wireio/cluster-tool-shared"
import { AnvilProcess } from "../../cluster/processes/AnvilProcess.js"
import { KiodProcess } from "../../cluster/processes/KiodProcess.js"
import { NodeopProcess } from "../../cluster/processes/NodeopProcess.js"
import { SolanaValidatorProcess } from "../../cluster/processes/SolanaValidatorProcess.js"
import {
  DaemonConfig,
  type DaemonConfigSources
} from "../../config/DaemonConfig.js"
import { NodeConfig } from "../../config/NodeConfig.js"
import { StartScriptRenderer } from "../../config/renderers/StartScriptRenderer.js"
import { Report } from "../../report/Report.js"
import { mkdirs } from "../../utils/fsUtils.js"
import { ClusterBuildContext } from "../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../ClusterBuildStep.js"
import { ClusterBuildPhase } from "../ClusterBuildPhase.js"
import type { StepInput } from "../StepRunner.js"
import { NodeopProcessSteps } from "./processes/NodeopProcessSteps.js"
import { SolanaValidatorProcessSteps } from "./processes/SolanaValidatorProcessSteps.js"

/**
 * Steps that emit each daemon's `start.sh` — the command needed to run that
 * daemon wherever the cluster tree is unpacked.
 *
 * Published cluster artifacts are otherwise not self-describing: the argv lives
 * only inside `wire-cluster-tool`, so a consumer who unpacks the tarball has to
 * reverse-engineer how to start anything.
 */
export namespace StartScriptSteps {
  /** Input for {@link planEmit} — which daemon's script to write. */
  export interface EmitInput extends StepInput {
    readonly kind: "StartScriptSteps.EmitInput"
    /** The daemon's label (node name, `anvil`, `kiod`, …). */
    readonly label: string
  }

  /**
   * Resolve the per-daemon configs for `ctx`'s cluster — the SAME configs the
   * live processes spawn from, rebuilt through each daemon's pure
   * `resolveConfig` rather than hand-assembled.
   *
   * Node options are rebuilt exactly as `NodeopProcessSteps.runStart` builds
   * them (`resolveOperator` + `resolveOperatorDaemonArgs`), so a producing
   * node's signing providers and an operator node's OPP daemon args are
   * identical to what the harness actually started. `supportsTraceNoAbis` is
   * forced FALSE here: it is a build-host capability probe, and the renderer
   * re-emits it as a run-time test instead of freezing today's answer.
   *
   * @param ctx - The build context.
   * @returns The sources for {@link DaemonConfig.plan}.
   */
  export function resolveSources<C extends ClusterBuildContext>(
    ctx: C
  ): DaemonConfigSources {
    const config = ctx.config,
      // The daemon SET is decided in ONE place. Re-writing
      // `externalOutposts != null` / `debuggingServerEnabled === false` here
      // would be a second predicate that can drift from `plannedLabels` — and
      // the drift direction where THIS yields a daemon the labels omit is
      // silent (no emit step is ever planned for it).
      labels = new Set(DaemonConfig.plannedLabels(config)),
      genesisTimestamp = NodeopProcess.readGenesisTimestamp(config),
      nodeop = NodeConfig.plan(config).map(node => {
        const operator = NodeopProcessSteps.resolveOperator(ctx, node)
        return NodeopProcess.resolveConfig(
          {
            node,
            operator,
            extraArgs: NodeopProcessSteps.resolveOperatorDaemonArgs(
              ctx,
              node,
              operator
            )
          },
          { genesisTimestamp, supportsTraceNoAbis: false }
        )
      })
    return {
      nodeop,
      // Each daemon is resolved iff the ONE enumeration plans it.
      anvil: labels.has(AnvilProcess.ProcessLabel)
        ? resolveAnvilConfig(config)
        : undefined,
      solanaValidator: labels.has(SolanaValidatorProcess.ProcessLabel)
        ? resolveSolanaValidatorConfig(config)
        : undefined,
      kiod: labels.has(KiodProcess.ProcessLabel)
        ? resolveKiodConfig(config)
        : undefined,
      debuggingServer: labels.has(DaemonConfig.DebuggingServerSubpath)
        ? {
            address: config.bind.debuggingServer.address,
            port: config.bind.debuggingServer.port
          }
        : undefined
    }
  }

  /** The anvil config in its RUN form — interval mining on (see {@link DaemonConfig}). */
  export function resolveAnvilConfig(config: ClusterConfig) {
    return AnvilProcess.resolveConfig(
      {
        host: config.bind.anvil.address,
        chainId: AnvilProcess.DefaultChainId,
        stateFile: Path.join(
          config.dataPath,
          AnvilProcess.StateSubpath,
          AnvilProcess.StateFilename
        ),
        slotsInAnEpoch: AnvilProcess.SlotsInAnEpoch,
        blockTimeSec: AnvilProcess.BlockTimeSec
      },
      { binary: config.executables.anvil, port: config.bind.anvil.port }
    )
  }

  /** The validator config, from the cluster's resolved bind window + ledger dir. */
  export function resolveSolanaValidatorConfig(config: ClusterConfig) {
    return SolanaValidatorProcess.resolveConfig(
      {
        address: config.bind.solana.address,
        ledgerPath: Path.join(
          config.dataPath,
          SolanaValidatorProcess.LedgerSubpath
        ),
        // The SAME resolution `runStart` uses. Omitting it renders a validator
        // argv with no `--upgradeable-program`, so a script-started validator
        // comes up WITHOUT the opp-outpost program — surfacing as a
        // one-direction OPP circulation stall, never a startup error.
        programs: SolanaValidatorProcessSteps.resolvePrograms(config)
      },
      {
        binary: config.executables.solanaTestValidator,
        rpcPort: config.bind.solana.ports.http,
        faucetPort: config.bind.solana.ports.faucet,
        gossipPort: config.bind.solana.ports.gossip,
        dynamicPortRange: config.bind.solana.ports.dynamicRange
      }
    )
  }

  /** The kiod config, from the cluster's wallet dir + resolved bind. */
  export function resolveKiodConfig(config: ClusterConfig) {
    return KiodProcess.resolveConfig(
      {
        binary: config.executables.kiod,
        walletPath: config.walletPath,
        address: config.bind.kiod.address
      },
      { port: config.bind.kiod.port }
    )
  }

  /**
   * Write every daemon's `start.sh` for a cluster — the ONE implementation
   * shared by `create` emission and `create-external-config`'s Rebind.
   *
   * DELETE-then-render: every pre-existing `start.sh` under the data dir is
   * removed first. Rebind clones the local tree wholesale (it excludes only
   * `logs`/`reports`/`*.pid`), so a daemon the external model drops — anvil and
   * the validator under external-outpost mode — would otherwise keep its
   * LOCAL-port script, and the Verify scan cannot flag a file it never
   * enumerates.
   *
   * @param config - The resolved cluster config.
   * @param sources - The per-daemon configs (see {@link resolveSources}).
   * @returns The absolute paths written.
   */
  export function writeAll(
    config: ClusterConfig,
    sources: DaemonConfigSources
  ): string[] {
    DaemonConfig.existingStartScriptFiles(
      config.dataPath,
      Fs.existsSync,
      Fs.readdirSync as (path: string) => string[]
    ).forEach(file => Fs.rmSync(file, { force: true }))
    return DaemonConfig.plan(config, sources).map(daemon =>
      write(config, daemon)
    )
  }

  /**
   * Write ONE daemon's `start.sh`.
   *
   * `mkdirs` is defensive rather than assumed: a `ManagedProcess` creates its
   * directory in `start()`, not at construction, and the debugging server's
   * directory is created by the bundle-copy step.
   *
   * @param config - The resolved cluster config.
   * @param daemon - The daemon to render.
   * @returns The absolute path written.
   */
  export function write(config: ClusterConfig, daemon: DaemonConfig): string {
    const file = DaemonConfig.startScriptFile(daemon.daemonPath)
    mkdirs(daemon.daemonPath)
    Fs.writeFileSync(
      file,
      new StartScriptRenderer(
        daemon,
        DaemonConfig.clusterRelocations(config)
      ).render(),
      { mode: ExecutableMode }
    )
    // Set explicitly as well as at write: `writeFileSync`'s mode applies only
    // when it CREATES the file, so a re-render over an existing script (Rebind,
    // or a repeated create into the same tree) would otherwise keep the old
    // non-executable bits.
    Fs.chmodSync(file, ExecutableMode)
    return file
  }

  /**
   * Mode for an emitted `start.sh` — `rwxr-xr-x`.
   *
   * The scripts are meant to be RUN (`./start.sh`), not sourced through an
   * interpreter, so the executable bit is part of the deliverable. Group/other
   * read+execute matches how the rest of the cluster tree ships; note that under
   * a `KEY`-mode cluster the file also carries an inline signing key, which the
   * script's own header states.
   */
  export const ExecutableMode = 0o755

  /**
   * Plan one emit Step per daemon — never a single step looping over N, so the
   * Report validates each script individually.
   *
   * @param parent - The phase these steps register on.
   * @param labels - One daemon label per step to emit.
   * @returns The parent phase.
   */
  export function planPhase<C extends ClusterBuildContext = ClusterBuildContext>(
    parent: ClusterBuildPhase<C>,
    labels: readonly string[]
  ): ClusterBuildPhase<C> {
    labels.forEach(label =>
      parent.push(
        planEmit<C>(
          Report.Actor.Sysio,
          `emit-start-script-${label}`,
          `emit ${label} start.sh`,
          {},
          label
        )
      )
    )
    return parent
  }

  /**
   * Emit ONE daemon's start script.
   *
   * @param actor - The Report actor.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step options.
   * @param label - The daemon's label.
   * @returns The emit step.
   */
  export function planEmit<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    label: string
  ): ClusterBuildStep<C, EmitInput> {
    return ClusterBuildStep.create<C, EmitInput>(
      actor,
      name,
      description,
      options,
      { kind: "StartScriptSteps.EmitInput", label },
      runEmit
    )
  }

  /** Named runner — render + write this daemon's `start.sh`. */
  export async function runEmit<C extends ClusterBuildContext>(
    ctx: C,
    input: EmitInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    // Namespace-qualified so the resolution is a seam a test can substitute —
    // building a context rich enough to resolve every operator is not the
    // subject of this step's own tests.
    const daemon = DaemonConfig.plan(
      ctx.config,
      StartScriptSteps.resolveSources(ctx)
    ).find(candidate => candidate.label === input.label)
    // ASSERT, never a silent return: a label the enumeration no longer plans
    // means the two have drifted, and returning quietly would record a PASSING
    // Report step that wrote no file — defeating exactly the per-daemon
    // validation this step exists to provide.
    Assert.ok(
      daemon != null,
      `start.sh: no planned daemon named '${input.label}' — the emit labels and DaemonConfig.plan have drifted`
    )
    write(ctx.config, daemon)
  }
}
