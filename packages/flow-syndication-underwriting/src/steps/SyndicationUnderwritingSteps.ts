import Assert from "node:assert"

import { SysioContracts } from "@wireio/sdk-core"
import {
  SyndicationScenario,
  WireSyndicationTool,
  matchesProtoEnum,
  pollUntil,
  verifyStep,
  type Report,
  type ClusterBuildStepOptions
} from "@wireio/cluster-tool"
import { SyndicationUnderwritingScenarioConstants as Constants } from "../SyndicationUnderwritingScenarioConstants.js"

/** Report-visible underwriting settlement checks. */
export namespace SyndicationUnderwritingSteps {
  /**
   * Verify APPROVED and the exact returned bond plus bounty. Once this bond is
   * paid the underwriter daemon may bond the second request in its next pass,
   * so a stake on that request still counts as the bonder's.
   */
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
        const expected =
          ctx.outputs.assert(Constants.Before).bonder + BigInt(request.bounty)
        // The balance and the bond rows are two reads: retry until both see the
        // same state.
        await pollUntil(
          "the bonder's balance plus its stake on the second request returns to its starting balance",
          async () => {
            const staked = (
              await WireSyndicationTool.readBonds(
                ctx,
                ctx.outputs.assert(Constants.SecondRequest)
              )
            )
              .filter(
                bond =>
                  bond.underwriter === SyndicationScenario.Bonder && !bond.paid
              )
              .reduce((sum, bond) => sum + BigInt(bond.amount), 0n)
            return (
              (await SyndicationScenario.readBalance(
                ctx,
                SyndicationScenario.Bonder
              )) +
                staked ===
              expected
            )
          },
          WireSyndicationTool.underwriterPassBudgetMs(ctx.config.producerCount),
          SyndicationScenario.PollMs
        )
      },
      options
    )
  }
}
