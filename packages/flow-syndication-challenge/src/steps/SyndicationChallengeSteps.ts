import { SysioContracts } from "@wireio/sdk-core"
import {
  getLogger,
  ClusterBuildStep,
  Steps,
  WireClient,
  SyndicationScenario,
  type ClusterBuildContext,
  type StepInput,
  type Report,
  type ClusterBuildStepOptions
} from "@wireio/cluster-tool"
import { SyndicationChallengeScenarioConstants as Constants } from "../SyndicationChallengeScenarioConstants.js"

const log = getLogger(__filename)

/** Runtime action inputs resolve the request and epoch through the output store. */
export namespace SyndicationChallengeSteps {
  /** One transfer's generated ABI data. */
  export interface TransferInput extends StepInput {
    readonly kind: "SyndicationChallengeSteps.TransferInput"
    readonly data: SysioContracts.SysioLiqTransferAction
  }
  /** Plan independent challenger funding. */
  export function planFund(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<ClusterBuildContext, TransferInput> {
    return ClusterBuildStep.create(
      actor,
      name,
      description,
      options,
      {
        kind: "SyndicationChallengeSteps.TransferInput",
        data: {
          from: SyndicationScenario.Bonder,
          to: Constants.Challenger.account,
          quantity: SyndicationScenario.quantity(Constants.ChallengerFunding),
          memo: "challenge funding"
        }
      },
      runFund
    )
  }
  /** Perform one shadow transfer. */
  export async function runFund(
    ctx: ClusterBuildContext,
    input: TransferInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContracts.SysioContractName.liq)
      .actions.transfer.invoke(input.data, {
        authorization: WireClient.activeAuthorization(input.data.from)
      })
  }
  /** Runtime action identity. */
  export interface ChallengeInput extends StepInput {
    readonly kind: "SyndicationChallengeSteps.ChallengeInput"
    readonly epoch: typeof Constants.Epoch
  }
  /** Plan one challenge of the captured epoch. */
  export function planChallenge(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<ClusterBuildContext, ChallengeInput> {
    return ClusterBuildStep.create(
      actor,
      name,
      description,
      options,
      {
        kind: "SyndicationChallengeSteps.ChallengeInput",
        epoch: Constants.Epoch
      },
      runChallenge
    )
  }
  /** Delegate the single challenge to the contract Step runner. */
  export async function runChallenge(
    ctx: ClusterBuildContext,
    input: ChallengeInput,
    signal: AbortSignal
  ): Promise<void> {
    await Steps.contracts.sysio.synd.runChallenge(
      ctx,
      {
        kind: "SyndContractSteps.ChallengeInput",
        data: {
          challenger: Constants.Challenger.account,
          chain_code: SyndicationScenario.Chain,
          token_code: SyndicationScenario.Token,
          epoch_index: ctx.outputs.assert(input.epoch)
        }
      },
      signal
    )
  }
  /** Runtime request identity for ruling and claims. */
  export interface RequestInput extends StepInput {
    readonly kind: "SyndicationChallengeSteps.RequestInput"
    readonly request: typeof Constants.Request
    readonly account: string
  }
  /** Plan the governance INVALID ruling. */
  export function planInvalid(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<ClusterBuildContext, RequestInput> {
    return ClusterBuildStep.create(
      actor,
      name,
      description,
      options,
      {
        kind: "SyndicationChallengeSteps.RequestInput",
        request: Constants.Request,
        account: Constants.Challenger.account
      },
      runInvalid
    )
  }
  /** One INVALID ruling, signed by sysio through the existing runner. */
  export async function runInvalid(
    ctx: ClusterBuildContext,
    input: RequestInput,
    signal: AbortSignal
  ): Promise<void> {
    await Steps.contracts.sysio.bond.runRslvinvalid(
      ctx,
      {
        kind: "BondContractSteps.RslvinvalidInput",
        data: { request_id: ctx.outputs.assert(input.request) }
      },
      signal
    )
  }
  /** Plan the challenger's pull payment. */
  export function planClaim(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    account: string
  ): ClusterBuildStep<ClusterBuildContext, RequestInput> {
    return ClusterBuildStep.create(
      actor,
      name,
      description,
      options,
      {
        kind: "SyndicationChallengeSteps.RequestInput",
        request: Constants.Request,
        account
      },
      runClaim
    )
  }
  /** Claim once, storing the bonder's expected refusal for a separate verify Step. */
  export async function runClaim(
    ctx: ClusterBuildContext,
    input: RequestInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    if (input.account !== SyndicationScenario.Bonder) {
      await Steps.contracts.sysio.bond.runClaim(
        ctx,
        {
          kind: "BondContractSteps.ClaimInput",
          data: {
            request_id: ctx.outputs.assert(input.request),
            account: input.account
          },
          signer: input.account
        },
        signal
      )
      return
    }
    try {
      await Steps.contracts.sysio.bond.runClaim(
        ctx,
        {
          kind: "BondContractSteps.ClaimInput",
          data: {
            request_id: ctx.outputs.assert(input.request),
            account: input.account
          },
          signer: input.account
        },
        signal
      )
      ctx.outputs.set(Constants.ClaimError, "")
    } catch (error) {
      log.info("Bonder claim refusal", error)
      ctx.outputs.set(Constants.ClaimError, String(error))
    }
  }
}
