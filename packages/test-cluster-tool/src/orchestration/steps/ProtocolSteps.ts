import Bluebird from "bluebird"
import { SysioContracts } from "@wireio/sdk-core"
import { Report } from "../../report/Report.js"
import { ClusterBuildContext } from "../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../ClusterBuildStep.js"
import type { StepInput } from "../StepRunner.js"

/** Steps that configure chain protocol state (features, instant finality). */
export namespace ProtocolSteps {
  /** Builtin-feature codename that must NOT be re-activated (already on at genesis). */
  const PreactivateFeatureCodename = "PREACTIVATE_FEATURE"
  /** Spec entry name carrying a feature's builtin codename. */
  const FeatureCodenameSpecName = "builtin_feature_codename"
  /** Benign "feature already on" error fragments. */
  const AlreadyActivatedFragments = ["already activated", "already been activated"]

  /** Activate every supported protocol feature (skipping PREACTIVATE). */
  export function activateFeatures<C extends ClusterBuildContext = ClusterBuildContext>(
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
      runActivateFeatures
    )
  }

  /** Named runner — fetch supported features, activate each (already-on is benign). */
  export async function runActivateFeatures<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const features = await ctx.wire.getSupportedProtocolFeatures()
    await Bluebird.each(features, async feature => {
      const codename = feature.specification?.find(
        spec => spec.name === FeatureCodenameSpecName
      )?.value
      if (codename === PreactivateFeatureCodename) return
      try {
        await ctx.wire.activateFeature(feature.feature_digest)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (AlreadyActivatedFragments.some(fragment => message.includes(fragment)))
          ctx.log.debug(`feature ${codename ?? feature.feature_digest} already activated`)
        else
          ctx.log.warn(
            `feature activation issue: ${codename ?? feature.feature_digest} — ${message}`
          )
      }
    })
  }

  /** Input for {@link setFinalizer} — the finalizer policy (generated action shape). */
  export interface SetFinalizerInput extends StepInput {
    readonly kind: "ProtocolSteps.SetFinalizerInput"
    readonly policy: SysioContracts.SysioBiosSetfinalizerAction["finalizer_policy"]
  }

  /** Activate BLS instant finality with the given finalizer policy. */
  export function setFinalizer<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    policy: SysioContracts.SysioBiosSetfinalizerAction["finalizer_policy"]
  ): ClusterBuildStep<C, SetFinalizerInput> {
    return ClusterBuildStep.create<C, SetFinalizerInput>(
      actor,
      name,
      description,
      options,
      { kind: "ProtocolSteps.SetFinalizerInput", policy },
      runSetFinalizer
    )
  }

  /** Named runner — `sysio::setfinalizer`. */
  export async function runSetFinalizer<C extends ClusterBuildContext>(
    ctx: C,
    input: SetFinalizerInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire.invoke<SysioContracts.SysioBiosSetfinalizerAction>(
      "sysio",
      "setfinalizer",
      { finalizer_policy: input.policy },
      [{ actor: "sysio", permission: "active" }]
    )
  }
}
