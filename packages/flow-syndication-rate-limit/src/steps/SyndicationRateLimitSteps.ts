import { SysioContracts } from "@wireio/sdk-core"
import {
  getLogger,
  ClusterBuildStep,
  Steps,
  SyndicationScenario,
  type ClusterBuildContext,
  type StepInput,
  type Report,
  type ClusterBuildStepOptions
} from "@wireio/cluster-tool"
import { SyndicationRateLimitScenarioConstants as Constants } from "../SyndicationRateLimitScenarioConstants.js"

const log = getLogger(__filename)

/** Expected action refusals remain visible as individual write Steps. */
export namespace SyndicationRateLimitSteps {
  /** Exact attempted redemption. */
  export interface RefusedDesyndicationInput extends StepInput {
    readonly kind: "SyndicationRateLimitSteps.RefusedDesyndicationInput"
    readonly data: SysioContracts.SysioSyndDesyndicateAction
  }
  /** Plan one redemption that exceeds even a full desyndication bucket. */
  export function planRefusedDesyndication(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<ClusterBuildContext, RefusedDesyndicationInput> {
    return ClusterBuildStep.create(
      actor,
      name,
      description,
      options,
      {
        kind: "SyndicationRateLimitSteps.RefusedDesyndicationInput",
        data: {
          holder: Constants.UserA.account,
          quantity: SyndicationScenario.quantity(
            Constants.DesyndicationBurst + 1n
          )
        }
      },
      runRefusedDesyndication
    )
  }
  /** Attempt one existing action runner and record the response for the verify Step. */
  export async function runRefusedDesyndication(
    ctx: ClusterBuildContext,
    input: RefusedDesyndicationInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    try {
      await Steps.contracts.sysio.synd.runDesyndicate(
        ctx,
        { kind: "SyndContractSteps.DesyndicateInput", data: input.data },
        signal
      )
      ctx.outputs.set(Constants.Refusal, "")
    } catch (error) {
      log.info("Desyndication budget refusal", error)
      ctx.outputs.set(Constants.Refusal, String(error))
    }
  }
}
