import Assert from "node:assert"

import { Base58, KeyType, SysioContracts } from "@wireio/sdk-core"
import { ChainKind } from "@wireio/opp-typescript-models"
import { AuthExLinkTool } from "../../tools/all/index.js"
import { WireClient } from "../../clients/wire/index.js"
import { SolanaFundingTool } from "../../tools/solana/index.js"
import { EthereumSyndicationTool } from "../../tools/ethereum/EthereumSyndicationTool.js"
import { WireSyndicationTool } from "../../tools/wire/WireSyndicationTool.js"
import { Constants } from "../../Constants.js"
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
  /** The NET / CPU / RAM weights of one node-owner resource policy, as `SYS` assets. */
  export interface PolicyWeights {
    readonly net: string
    readonly cpu: string
    readonly ram: string
  }

  /**
   * The `sysio.roa::addpolicy` the bootstrap node owner issues to `owner`: the ONE builder of
   * a node-owner policy, so every flow account and harness account is funded the same way.
   *
   * @param owner - The account receiving the resources.
   * @param weights - Its NET / CPU / RAM weights.
   * @return The action payload.
   */
  export function nodeOwnerPolicy(
    owner: string,
    weights: PolicyWeights
  ): SysioContracts.SysioRoaAddpolicyAction {
    return {
      owner,
      issuer: Constants.BOOTSTRAP_NODE_OWNER,
      net_weight: weights.net,
      cpu_weight: weights.cpu,
      ram_weight: weights.ram,
      time_block: 0,
      network_gen: 0
    }
  }

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

  /** Input of one Ethereum user link, using the same wallet that syndicates. */
  export interface LinkEthereumKeyInput extends StepInput {
    readonly kind: "SyndicationUserSteps.LinkEthereumKeyInput"
    readonly account: string
    readonly ethereumHdIndex: number
  }

  /**
   * Link the local Ethereum user's wallet to its WIRE destination account.
   * @param actor - The narrative actor.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step execution options.
   * @param account - WIRE destination account.
   * @param ethereumHdIndex - The prefunded local wallet's index.
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
    ethereumHdIndex: number
  ): ClusterBuildStep<C, LinkEthereumKeyInput> {
    return ClusterBuildStep.create<C, LinkEthereumKeyInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "SyndicationUserSteps.LinkEthereumKeyInput",
        account,
        ethereumHdIndex
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
    const ethereumWallet = EthereumSyndicationTool.hdWallet(
      ctx,
      input.ethereumHdIndex
    )
    await AuthExLinkTool.createLink(ctx.wire, {
      chainKind: ChainKind.EVM,
      account: input.account,
      ethereumWallet,
      privateKey: privateKeyFromNativeString(
        KeyType.EM,
        ethereumWallet.privateKey
      )
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
