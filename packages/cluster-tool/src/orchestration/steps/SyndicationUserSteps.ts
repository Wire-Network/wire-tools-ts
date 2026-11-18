import Assert from "node:assert"

import { SysioContracts } from "@wireio/sdk-core"
import { ChainKind } from "@wireio/opp-typescript-models"
import { AuthExLinkTool } from "../../tools/all/index.js"
import { SolanaFundingTool } from "../../tools/solana/index.js"
import { EthereumFundingTool } from "../../tools/ethereum/EthereumFundingTool.js"
import { WireSyndicationTool } from "../../tools/wire/WireSyndicationTool.js"
import {
  ethereumPublicKeyFromWallet,
  solanaKeyPairFromKeypair,
  solanaSignerFromKeypair
} from "../../utils/keyPairUtils.js"
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
      // The linked key is the keypair's own point; the keypair proves it.
      publicKey: solanaKeyPairFromKeypair(keypair).publicKey,
      signer: solanaSignerFromKeypair(keypair)
    })
  }

  /** Input of one Ethereum user link, using the same wallet that syndicates. */
  export interface LinkEthereumKeyInput extends StepInput {
    readonly kind: "SyndicationUserSteps.LinkEthereumKeyInput"
    readonly account: string
    /** Durable handle of the user's persisted Ethereum wallet. */
    readonly walletName: string
  }

  /**
   * Link the local Ethereum user's wallet to its WIRE destination account.
   * @param actor - The narrative actor.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step execution options.
   * @param account - WIRE destination account.
   * @param walletName - Durable handle of the user's persisted Ethereum wallet.
   * @returns One createlink Step.
   */
  export function planLinkEthereumKey<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    account: string,
    walletName: string
  ): ClusterBuildStep<C, LinkEthereumKeyInput> {
    return ClusterBuildStep.create<C, LinkEthereumKeyInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "SyndicationUserSteps.LinkEthereumKeyInput",
        account,
        walletName
      },
      runLinkEthereumKey
    )
  }

  /** Sign one user createlink with the exact Ethereum wallet used by the syndication. */
  export async function runLinkEthereumKey<C extends ClusterBuildContext>(
    ctx: C,
    input: LinkEthereumKeyInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const wallet = EthereumFundingTool.signer(ctx, input.walletName)
    await AuthExLinkTool.createLink(ctx.wire, {
      chainKind: ChainKind.EVM,
      account: input.account,
      publicKey: ethereumPublicKeyFromWallet(wallet).toString(),
      signer: wallet
    })
  }

  /** Input of the parked-credit verify Steps: whose credit, in which token, and its net. */
  export interface ParkedCreditInput extends StepInput {
    readonly kind: "SyndicationUserSteps.ParkedCreditInput"
    /** The recipient's WIRE account. */
    readonly account: string
    /** Durable handle of the recipient's persisted Solana keypair, the key credit parks under. */
    readonly keypairName: string
    /** The shadow codename (`LIQSOL`). */
    readonly tokenCode: string
    /** The net credit the release parks: the gross syndication minus its fee. */
    readonly expectedNet: bigint
  }

  /**
   * Verify an unlinked recipient's release parked exactly its net credit and left its account
   * empty. Nothing but the recipient's own `createlink` moves a parked row, so this holds
   * whoever bonded the request.
   *
   * @param actor - Report actor.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step options.
   * @param account - The recipient's WIRE account.
   * @param keypairName - Durable handle of its persisted Solana keypair.
   * @param tokenCode - The shadow codename.
   * @param expectedNet - The net credit.
   * @return The verify Step.
   */
  export function planVerifyParkedCredit<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    account: string,
    keypairName: string,
    tokenCode: string,
    expectedNet: bigint
  ): ClusterBuildStep<C, ParkedCreditInput> {
    return ClusterBuildStep.create<C, ParkedCreditInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "SyndicationUserSteps.ParkedCreditInput",
        account,
        keypairName,
        tokenCode,
        expectedNet
      },
      runVerifyParkedCredit
    )
  }

  /** Named runner — the parked row holds exactly the net and the account nothing. */
  export async function runVerifyParkedCredit<C extends ClusterBuildContext>(
    ctx: C,
    input: ParkedCreditInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const row = await readParkedCredit(ctx, input)
    Assert.ok(row, `nothing is parked for ${input.account}`)
    Assert.strictEqual(BigInt(row.balance), input.expectedNet)
    Assert.strictEqual(
      await WireSyndicationTool.readLiqBalance(
        ctx,
        input.account,
        input.tokenCode
      ),
      0n
    )
  }

  /**
   * Verify `createlink` delivered the parked net credit exactly once: the parked row is gone
   * (or empty) and the linked account holds the net.
   *
   * @param actor - Report actor.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step options.
   * @param account - The now-linked recipient's WIRE account.
   * @param keypairName - Durable handle of its persisted Solana keypair.
   * @param tokenCode - The shadow codename.
   * @param expectedNet - The net credit.
   * @return The verify Step.
   */
  export function planVerifyParkedDelivered<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    account: string,
    keypairName: string,
    tokenCode: string,
    expectedNet: bigint
  ): ClusterBuildStep<C, ParkedCreditInput> {
    return ClusterBuildStep.create<C, ParkedCreditInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "SyndicationUserSteps.ParkedCreditInput",
        account,
        keypairName,
        tokenCode,
        expectedNet
      },
      runVerifyParkedDelivered
    )
  }

  /** Named runner — the parked row is empty and the account holds exactly the net. */
  export async function runVerifyParkedDelivered<C extends ClusterBuildContext>(
    ctx: C,
    input: ParkedCreditInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const row = await readParkedCredit(ctx, input)
    Assert.strictEqual(row ? BigInt(row.balance) : 0n, 0n)
    Assert.strictEqual(
      await WireSyndicationTool.readLiqBalance(
        ctx,
        input.account,
        input.tokenCode
      ),
      input.expectedNet
    )
  }

  /** The SVM parked row of the recipient's persisted ED key, or nothing. */
  async function readParkedCredit(
    ctx: ClusterBuildContext,
    input: ParkedCreditInput
  ): Promise<SysioContracts.SysioSyndParkedRowType> {
    return WireSyndicationTool.readParked(
      ctx,
      input.tokenCode,
      SysioContracts.SysioSyndChainkind.CHAIN_KIND_SVM,
      SolanaFundingTool.publicKeyHex(ctx.config.dataPath, input.keypairName)
    )
  }
}
