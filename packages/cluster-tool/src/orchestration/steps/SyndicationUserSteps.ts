import { Base58, KeyType, SysioContracts } from "@wireio/sdk-core"
import { ChainKind } from "@wireio/opp-typescript-models"
import { AuthExLinkTool } from "../../tools/all/index.js"
import { WireClient } from "../../clients/wire/index.js"
import { SolanaFundingTool } from "../../tools/solana/index.js"
import { privateKeyFromNativeString } from "../../utils/keyPairUtils.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../ClusterBuildStep.js"
import type { ClusterBuildContext } from "../ClusterBuildContext.js"
import type { StepInput } from "../StepRunner.js"
import type { Report } from "../../report/Report.js"

/**
 * Shared syndication user Steps — the AuthX link that turns the depot's parked shadow
 * into the user's own holding. The Solana identity is the flow's persisted
 * keypair, so the linked key is exactly the one `synd` stamped on
 * `SYNDICATE_LIQ`.
 */
export namespace SyndicationUserSteps {
  /** Resource allocation carried by its own on-chain write. */
  export interface ResourcePolicyInput extends StepInput {
    readonly kind: "SyndicationUserSteps.ResourcePolicyInput"
    readonly data: SysioContracts.SysioRoaAddpolicyAction
  }

  /** Plan one resource policy for an already-created flow account. */
  export function planResourcePolicy<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioRoaAddpolicyAction
  ): ClusterBuildStep<C, ResourcePolicyInput> {
    return ClusterBuildStep.create<C, ResourcePolicyInput>(
      actor,
      name,
      description,
      options,
      { kind: "SyndicationUserSteps.ResourcePolicyInput", data },
      runResourcePolicy
    )
  }

  /** Perform ONE addpolicy, signed by the policy issuer. */
  export async function runResourcePolicy<C extends ClusterBuildContext>(
    ctx: C,
    input: ResourcePolicyInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContracts.SysioContractName.roa)
      .actions.addpolicy.invoke(input.data, {
        authorization: WireClient.activeAuthorization(input.data.issuer)
      })
  }

  /** Input for {@link planLinkSolanaKey}. */
  export interface LinkSolanaKeyInput extends StepInput {
    readonly kind: "SyndicationUserSteps.LinkSolanaKeyInput"
    /** WIRE account the key is linked to — the `createlink` signer. */
    readonly account: string
    /** Durable handle of the user's persisted Solana keypair. */
    readonly keypairName: string
  }

  /**
   * Link the user's Solana key to their WIRE account through a user-created
   * `sysio.authex::createlink`. The link's inline sweep delivers whatever
   * `sysio.synd` parked against that key.
   *
   * @param actor - The narrative subject (the user).
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param account - WIRE account the key is linked to.
   * @param keypairName - Durable handle of the user's persisted Solana keypair.
   * @returns The definition step.
   */
  export function planLinkSolanaKey<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    account: string,
    keypairName: string
  ): ClusterBuildStep<C, LinkSolanaKeyInput> {
    return ClusterBuildStep.create<C, LinkSolanaKeyInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "SyndicationUserSteps.LinkSolanaKeyInput",
        account,
        keypairName
      },
      runLinkSolanaKey
    )
  }

  /** Named runner — ONE `createlink`, signed by the account, proven by the ED key. */
  export async function runLinkSolanaKey<C extends ClusterBuildContext>(
    ctx: C,
    input: LinkSolanaKeyInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const keypair = SolanaFundingTool.loadKeypair(
      ctx.config.dataPath,
      input.keypairName
    )
    await AuthExLinkTool.createLink(ctx.wire, {
      chainKind: ChainKind.SVM,
      account: input.account,
      // The web3 secret key IS the ED key's native form: base58 of its 64 bytes.
      privateKey: privateKeyFromNativeString(
        KeyType.ED,
        Base58.encode(keypair.secretKey)
      )
    })
  }
}
