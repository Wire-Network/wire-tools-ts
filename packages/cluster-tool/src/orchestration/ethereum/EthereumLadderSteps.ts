import Fs from "node:fs"
import Path from "node:path"
import {
  EthereumFreezeReleaseStateCodec,
  EthereumLadderSummaryCodec,
  type EthereumFreezeReleaseState,
  type EthereumLadderSummary
} from "@wireio/cluster-tool-shared"
import { ClusterConfigProvider } from "../../config/ClusterConfigProvider.js"
import { Report } from "../../report/Report.js"
import { StepExtraRecorder } from "../../report/tools/StepExtraRecorder.js"
import { ClusterBuildContext } from "../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../ClusterBuildStep.js"
import {
  EthereumBookedFigureKey,
  EthereumLadderSummaryKey
} from "../outputs/EthereumLadderOutput.js"
import { EthereumOutpostBootstrapper } from "./EthereumOutpostBootstrapper.js"
import { EthereumOutpostSteps } from "./EthereumOutpostSteps.js"

/**
 * The pre-launch Ethereum outpost taken live, one script per Step: the
 * ladder (`deployLadder.ts`, mainnet's rungs up to the go-live), the deep
 * freeze (go-live step 0, which books `Depositor.lastPoolLiqBalance`), and the
 * go-live (step 1: the pool upgraded and seeded, the OPP pair and BAR fresh).
 * Between the ladder and the freeze the bootstrap exercises the pre-launch set
 * (`EthereumPreLaunchSteps`); between the freeze and the go-live it imports
 * the frozen positions into the depot (`EthereumLadderImportSteps`).
 */
export namespace EthereumLadderSteps {
  /** Plan the ladder — `deployLadder.ts` against the run anvil; one process, one Step. */
  export function planLadder<
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
      runLadder
    )
  }

  /** Named runner — climb the ladder, then publish its summary to `ctx.outputs`. */
  export async function runLadder<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    EthereumOutpostBootstrapper.assertOperatorsClearOfPanicAccount(
      ctx.config.batchOperatorCount,
      ctx.config.underwriterCount
    )
    await (await bootstrapper(ctx)).ladder()
    const summary = readLadderSummary(ctx)
    ctx.outputs.set(EthereumLadderSummaryKey, summary)
    StepExtraRecorder.note("ladder", {
      stoppedBefore: summary.stoppedBefore,
      completed: summary.completed,
      wireNodes: summary.wireNodes
    })
  }

  /** Plan the deep freeze — go-live step 0 as the real `UPGRADE_CONFIG` script; one Step. */
  export function planDeepFreeze<
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
      runDeepFreeze
    )
  }

  /** Named runner — freeze, then publish the booked figure the freeze recorded. */
  export async function runDeepFreeze<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await (await bootstrapper(ctx)).deepFreeze()
    const state = readFreezeReleaseState(ctx),
      bookedFigure = BigInt(state.depositorLastPoolLiqBalance)
    ctx.outputs.set(EthereumBookedFigureKey, bookedFigure)
    StepExtraRecorder.note("booked figure", {
      depositorLastPoolLiqBalance: state.depositorLastPoolLiqBalance,
      depositorTotalShares: state.depositorTotalShares,
      depositorIndex: state.depositorIndex
    })
  }

  /** Plan the go-live — step 1 as the real `UPGRADE_CONFIG` script; one Step. */
  export function planGoLive<
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
      runGoLive
    )
  }

  /** Named runner — the go-live, with the ladder's WireNodes stand-in. */
  export async function runGoLive<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const summary = ctx.outputs.assert(EthereumLadderSummaryKey)
    await (await bootstrapper(ctx)).goLive(summary.wireNodes)
  }

  /** The ladder's summary, from this cluster's deployments dir. */
  export function readLadderSummary<C extends ClusterBuildContext>(
    ctx: C
  ): EthereumLadderSummary {
    return EthereumLadderSummaryCodec.deserialize(
      Fs.readFileSync(
        Path.join(
          ClusterConfigProvider.ethereumDeploymentsPath(ctx.config),
          EthereumOutpostBootstrapper.LadderSummaryFile
        ),
        "utf-8"
      )
    )
  }

  /** The release state the deep freeze recorded, from this cluster's deployments dir. */
  export function readFreezeReleaseState<C extends ClusterBuildContext>(
    ctx: C
  ): EthereumFreezeReleaseState {
    return EthereumFreezeReleaseStateCodec.deserialize(
      Fs.readFileSync(
        Path.join(
          ClusterConfigProvider.ethereumDeploymentsPath(ctx.config),
          EthereumOutpostBootstrapper.OutpostReleaseStateFile
        ),
        "utf-8"
      )
    )
  }

  /** The bootstrapper for this cluster's anvil, carrying the provisional roster the go-live seats. */
  async function bootstrapper<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<EthereumOutpostBootstrapper> {
    return new EthereumOutpostBootstrapper(
      EthereumOutpostSteps.bootstrapperOptions(
        ctx,
        await EthereumOutpostSteps.resolveInitialRoster(ctx)
      )
    )
  }
}
