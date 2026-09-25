import { Base58, KeyType } from "@wireio/sdk-core"
import { ChainKind } from "@wireio/opp-typescript-models"
import {
  AuthExLinkTool,
  ClusterBuildStep,
  SolanaFundingTool,
  privateKeyFromNativeString,
  type ClusterBuildContext,
  type ClusterBuildStepOptions,
  type Report,
  type StepInput
} from "@wireio/cluster-tool"

/**
 * Flow-local user Steps — the AuthX link that turns the depot's parked shadow
 * into the user's own holding. The Solana identity is the flow's persisted
 * keypair, so the linked key is exactly the one `synd` stamped on
 * `SYNDICATE_LIQ`.
 */
export namespace LIQYieldScenarioUserSteps {
  /** Input for {@link planLinkSolanaKey}. */
  export interface LinkSolanaKeyInput extends StepInput {
    readonly kind: "LIQYieldScenarioUserSteps.LinkSolanaKeyInput"
    /** WIRE account the key is linked to — the `createlink` signer. */
    readonly account: string
    /** Durable handle of the user's persisted Solana keypair. */
    readonly keypairName: string
  }

  /**
   * Link the user's Solana key to their WIRE account through a user-created
   * `sysio.authex::createlink`. The link's inline sweep delivers whatever
   * `sysio.liq` parked against that key.
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
        kind: "LIQYieldScenarioUserSteps.LinkSolanaKeyInput",
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
