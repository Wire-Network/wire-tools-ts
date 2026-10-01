import Assert from "node:assert"

import { SysioContracts } from "@wireio/sdk-core"
import {
  SyndicationScenario,
  WireSyndicationTool,
  matchesProtoEnum,
  verifyStep,
  type Report,
  type ClusterBuildStepOptions
} from "@wireio/cluster-tool"
import { SyndicationUnderwritingScenarioConstants as Constants } from "../SyndicationUnderwritingScenarioConstants.js"

/** Report-visible underwriting settlement checks. */
export namespace SyndicationUnderwritingSteps {
  /** Verify APPROVED and the exact returned bond plus bounty. */
  export function planVerifyClaim(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ) {
    return verifyStep(
      actor,
      name,
      description,
      async ctx => {
        const request = await WireSyndicationTool.readRequest(
          ctx,
          ctx.outputs.assert(Constants.FirstRequest)
        )
        Assert.ok(
          matchesProtoEnum(
            request.state,
            SysioContracts.SysioBondRequestState,
            SysioContracts.SysioBondRequestState.APPROVED
          )
        )
        Assert.strictEqual(
          await SyndicationScenario.readBalance(
            ctx,
            SyndicationScenario.Bonder
          ),
          ctx.outputs.assert(Constants.Before).bonder + BigInt(request.bounty)
        )
      },
      options
    )
  }
}
