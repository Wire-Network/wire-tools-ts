import Assert from "node:assert"
import { ChainKind } from "@wireio/opp-typescript-models"
import { ProtocolTiming } from "../../Constants.js"
import { Report } from "../../report/Report.js"
import { StepExtraRecorder } from "../../report/tools/StepExtraRecorder.js"
import { EthereumSyndicationTool } from "../../tools/ethereum/EthereumSyndicationTool.js"
import { SolanaFundingTool } from "../../tools/solana/SolanaFundingTool.js"
import { SolanaLiqSyndicationTool } from "../../tools/solana/SolanaLiqSyndicationTool.js"
import { WireSyndicationTool } from "../../tools/wire/WireSyndicationTool.js"
import { ClusterBuildContext } from "../ClusterBuildContext.js"
import { ClusterBuildPhase } from "../ClusterBuildPhase.js"
import type { ClusterBuildParent } from "../ClusterBuildPhaseBase.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../ClusterBuildStep.js"
import type { OutputKey } from "../OutputStore.js"
import {
  MockShadowBackingSolanaRequiredKey,
  MockShadowBackingEthereumRequiredKey,
  MockShadowBackingEthereumPrincipalKey
} from "../outputs/MockShadowBackingOutput.js"
import type { StepInput } from "../StepRunner.js"

/** Opt-in custody backing of every mock shadow, measured after all depot seeds. */
export namespace MockShadowBackingSteps {
  /** Persisted backer keypair handle, independent of the imported bonder. */
  export const SolanaBackerLabel = "mock-shadow-backer"
  /** The local deployer's funded anvil slot; never an operator or panic slot. */
  export const EthereumBackerHdIndex = 0
  /** SOL reserved for transaction fees, stake rent and ATA rent beyond the deposit. */
  export const SolanaFundingMargin = 1_000_000_000n
  /** Native liqETH wei per depot base unit (18 minus 9 decimals). */
  export const EthereumWeiPerDepotUnit = 1_000_000_000n
  /** Solana backer and the measured native amount carried between Steps. */
  export interface SolanaBackingInput extends StepInput {
    readonly kind: "MockShadowBackingSteps.SolanaBackingInput"
    readonly amountKey: OutputKey<bigint>
    readonly keypairName: string
  }
  /** Ethereum backer and the measured native amount carried between Steps. */
  export interface EthereumBackingInput extends StepInput {
    readonly kind: "MockShadowBackingSteps.EthereumBackingInput"
    readonly amountKey: OutputKey<bigint>
    readonly ethereumHdIndex: number
  }

  /** Selects one outpost for the read-before-write and final custody checks. */
  export interface CustodyInput extends StepInput {
    readonly kind: "MockShadowBackingSteps.CustodyInput"
    readonly chain: ChainKind.SVM | ChainKind.EVM
  }

  /** Compose Solana backing; every airdrop, deposit and donation has its own Step. */
  export function planSolana<
    C extends ClusterBuildContext = ClusterBuildContext
  >(parent: ClusterBuildParent<C>): ClusterBuildPhase<C> {
    const options = { timeoutMs: ProtocolTiming.OutpostWriteBudgetMs }
    return ClusterBuildPhase.create<C>(
      parent,
      "MockShadowBackingSolana",
      "Back all mock LIQSOL shadow in the pool ATA",
      [
        planReadCustody<C>(
          Report.Actor.SolanaOutpost,
          "read-mock-shadow-custody-solana",
          "read custody and outstanding before funding",
          options,
          ChainKind.SVM
        ),
        planAirdropSolana<C>(
          Report.Actor.SolanaOutpost,
          "airdrop-mock-shadow-backer",
          "fund the backer's deposit and rent",
          options
        ),
        planDepositSolana<C>(
          Report.Actor.SolanaOutpost,
          "deposit-mock-shadow-backing-solana",
          "deposit SOL for liqSOL backing",
          options
        ),
        planDonateSolana<C>(
          Report.Actor.SolanaOutpost,
          "donate-mock-shadow-backing-solana",
          "donate liqSOL into the pool ATA",
          options
        ),
        planVerifyCustody<C>(
          Report.Actor.SolanaOutpost,
          "verify-mock-shadow-backing-solana",
          "pool custody covers outstanding LIQSOL",
          options,
          ChainKind.SVM
        )
      ]
    )
  }

  /** Compose Ethereum backing after all mock shadow has been minted. */
  export function planEthereum<
    C extends ClusterBuildContext = ClusterBuildContext
  >(parent: ClusterBuildParent<C>): ClusterBuildPhase<C> {
    const options = { timeoutMs: ProtocolTiming.OutpostWriteBudgetMs }
    return ClusterBuildPhase.create<C>(
      parent,
      "MockShadowBackingEthereum",
      "Back all mock LIQETH shadow in SyndicationPool",
      [
        planReadCustody<C>(
          Report.Actor.EthereumOutpost,
          "read-mock-shadow-custody-ethereum",
          "read custody and outstanding before depositing",
          options,
          ChainKind.EVM
        ),
        planDepositEthereum<C>(
          Report.Actor.EthereumOutpost,
          "deposit-mock-shadow-backing-ethereum",
          "deposit ETH for liqETH backing",
          options
        ),
        planDonateEthereum<C>(
          Report.Actor.EthereumOutpost,
          "donate-mock-shadow-backing-ethereum",
          "donate liqETH into SyndicationPool",
          options
        ),
        planInitializeEthereum<C>(
          Report.Actor.EthereumOutpost,
          "initialize-mock-shadow-principal-ethereum",
          "reconcile SyndicationPool principal with mock shadow",
          options
        ),
        planVerifyCustody<C>(
          Report.Actor.EthereumOutpost,
          "verify-mock-shadow-backing-ethereum",
          "pool custody covers outstanding LIQETH",
          options,
          ChainKind.EVM
        )
      ]
    )
  }

  /** Read current custody and the entire depot obligation in depot base units. */
  async function readCustody<C extends ClusterBuildContext>(
    ctx: C,
    input: CustodyInput
  ) {
    const solana = input.chain === ChainKind.SVM,
      outstanding = await WireSyndicationTool.readOutstanding(
        ctx,
        solana ? "LIQSOL" : "LIQETH"
      ),
      custody = solana
        ? await SolanaLiqSyndicationTool.readPoolBalance(ctx)
        : await EthereumSyndicationTool.readPoolBalanceDepot(ctx)
    StepExtraRecorder.note("mock shadow custody reconciliation", {
      chain: input.chain,
      outstanding: outstanding.toString(),
      custody: custody.toString()
    })
    return { outstanding, custody }
  }

  /** Capture the required backing before moving funds; do not count existing custody twice. */
  export async function runReadCustody<C extends ClusterBuildContext>(
    ctx: C,
    input: CustodyInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const { outstanding, custody } = await readCustody(ctx, input),
      solana = input.chain === ChainKind.SVM,
      required = custody >= outstanding ? 0n : outstanding - custody
    if (!solana) ctx.outputs.set(MockShadowBackingEthereumPrincipalKey, outstanding)
    ctx.outputs.set(
      solana
        ? MockShadowBackingSolanaRequiredKey
        : MockShadowBackingEthereumRequiredKey,
      required * (solana ? 1n : EthereumWeiPerDepotUnit)
    )
  }

  /** Re-read custody and outstanding; a shortfall fails this Report checkpoint. */
  export async function runVerifyCustody<C extends ClusterBuildContext>(
    ctx: C,
    input: CustodyInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const { outstanding, custody } = await readCustody(ctx, input)
    Assert.ok(
      custody >= outstanding,
      `mock shadow custody shortfall: ${custody} < ${outstanding}`
    )
    if (input.chain === ChainKind.EVM) {
      const backing = ctx.outputs.assert(MockShadowBackingEthereumPrincipalKey),
        principal = await EthereumSyndicationTool.readSyndicatedPrincipal(ctx)
      Assert.equal(principal, backing, "mock shadow principal must equal backing")
      Assert.ok(custody >= backing, "mock shadow custody must cover seeded principal")
      StepExtraRecorder.note("mock shadow principal reconciliation", {
        backing: backing.toString(), principal: principal.toString(), custody: custody.toString()
      })
    }
  }

  /** Plan the ReadCustody checkpoint for one outpost. */
  export function planReadCustody<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    chain: CustodyInput["chain"]
  ): ClusterBuildStep<C, CustodyInput> {
    return ClusterBuildStep.create<C, CustodyInput>(
      actor,
      name,
      description,
      options,
      { kind: "MockShadowBackingSteps.CustodyInput", chain },
      runReadCustody
    )
  }

  /** Plan the VerifyCustody checkpoint for one outpost. */
  export function planVerifyCustody<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    chain: CustodyInput["chain"]
  ): ClusterBuildStep<C, CustodyInput> {
    return ClusterBuildStep.create<C, CustodyInput>(
      actor,
      name,
      description,
      options,
      { kind: "MockShadowBackingSteps.CustodyInput", chain },
      runVerifyCustody
    )
  }

  /** Plan one AirdropSolana write with the amount resolved from the custody reading. */
  export function planAirdropSolana<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, SolanaBackingInput> {
    return ClusterBuildStep.create<C, SolanaBackingInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "MockShadowBackingSteps.SolanaBackingInput",
        amountKey: MockShadowBackingSolanaRequiredKey,
        keypairName: SolanaBackerLabel
      },
      runAirdropSolana
    )
  }

  /** Resolve backing from ctx.outputs, then perform at most one AirdropSolana write. */
  export async function runAirdropSolana<C extends ClusterBuildContext>(
    ctx: C,
    input: SolanaBackingInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const amount = ctx.outputs.assert(input.amountKey)
    if (amount === 0n) return
    Assert.ok(amount > 0n, "mock shadow backing must not be negative")
    const step = SolanaFundingTool.planKeypairAirdrop<C>(
      Report.Actor.User,
      "AirdropSolana",
      "mock shadow custody backing",
      {},
      input.keypairName,
      amount + SolanaFundingMargin
    )
    await step.runner(ctx, step.input, signal)
  }

  /** Plan one DepositSolana write with the amount resolved from the custody reading. */
  export function planDepositSolana<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, SolanaBackingInput> {
    return ClusterBuildStep.create<C, SolanaBackingInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "MockShadowBackingSteps.SolanaBackingInput",
        amountKey: MockShadowBackingSolanaRequiredKey,
        keypairName: SolanaBackerLabel
      },
      runDepositSolana
    )
  }

  /** Resolve backing from ctx.outputs, then perform at most one DepositSolana write. */
  export async function runDepositSolana<C extends ClusterBuildContext>(
    ctx: C,
    input: SolanaBackingInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const amount = ctx.outputs.assert(input.amountKey)
    if (amount === 0n) return
    Assert.ok(amount > 0n, "mock shadow backing must not be negative")
    const step = SolanaLiqSyndicationTool.planDepositForLiqsol<C>(
      Report.Actor.User,
      "DepositSolana",
      "mock shadow custody backing",
      {},
      input.keypairName,
      amount
    )
    await step.runner(ctx, step.input, signal)
  }

  /** Plan one DonateSolana write with the amount resolved from the custody reading. */
  export function planDonateSolana<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, SolanaBackingInput> {
    return ClusterBuildStep.create<C, SolanaBackingInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "MockShadowBackingSteps.SolanaBackingInput",
        amountKey: MockShadowBackingSolanaRequiredKey,
        keypairName: SolanaBackerLabel
      },
      runDonateSolana
    )
  }

  /** Resolve backing from ctx.outputs, then perform at most one DonateSolana write. */
  export async function runDonateSolana<C extends ClusterBuildContext>(
    ctx: C,
    input: SolanaBackingInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const amount = ctx.outputs.assert(input.amountKey)
    if (amount === 0n) return
    Assert.ok(amount > 0n, "mock shadow backing must not be negative")
    const step = SolanaLiqSyndicationTool.planDonateToPool<C>(
      Report.Actor.User,
      "DonateSolana",
      "mock shadow custody backing",
      {},
      input.keypairName,
      amount
    )
    await step.runner(ctx, step.input, signal)
  }

  /** Plan one DepositEthereum write with the amount resolved from the custody reading. */
  export function planDepositEthereum<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, EthereumBackingInput> {
    return ClusterBuildStep.create<C, EthereumBackingInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "MockShadowBackingSteps.EthereumBackingInput",
        amountKey: MockShadowBackingEthereumRequiredKey,
        ethereumHdIndex: EthereumBackerHdIndex
      },
      runDepositEthereum
    )
  }

  /** Resolve backing from ctx.outputs, then perform at most one DepositEthereum write. */
  export async function runDepositEthereum<C extends ClusterBuildContext>(
    ctx: C,
    input: EthereumBackingInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const amount = ctx.outputs.assert(input.amountKey)
    if (amount === 0n) return
    Assert.ok(amount > 0n, "mock shadow backing must not be negative")
    const step = EthereumSyndicationTool.planDepositLiqEth<C>(
      Report.Actor.User,
      "DepositEthereum",
      "mock shadow custody backing",
      {},
      input.ethereumHdIndex,
      amount
    )
    await step.runner(ctx, step.input, signal)
  }

  /** Plan one DonateEthereum write with the amount resolved from the custody reading. */
  export function planDonateEthereum<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, EthereumBackingInput> {
    return ClusterBuildStep.create<C, EthereumBackingInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "MockShadowBackingSteps.EthereumBackingInput",
        amountKey: MockShadowBackingEthereumRequiredKey,
        ethereumHdIndex: EthereumBackerHdIndex
      },
      runDonateEthereum
    )
  }

  /** Resolve backing from ctx.outputs, then perform at most one DonateEthereum write. */
  export async function runDonateEthereum<C extends ClusterBuildContext>(
    ctx: C,
    input: EthereumBackingInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const amount = ctx.outputs.assert(input.amountKey)
    if (amount === 0n) return
    Assert.ok(amount > 0n, "mock shadow backing must not be negative")
    const step = EthereumSyndicationTool.planDonateToPool<C>(
      Report.Actor.User,
      "DonateEthereum",
      "mock shadow custody backing",
      {},
      input.ethereumHdIndex,
      amount
    )
    await step.runner(ctx, step.input, signal)
  }
  /** Plan the restricted Ethereum principal seed as its own write. */
  export function planInitializeEthereum<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, EthereumBackingInput> {
    return ClusterBuildStep.create<C, EthereumBackingInput>(
      actor, name, description, options,
      {
        kind: "MockShadowBackingSteps.EthereumBackingInput",
        amountKey: MockShadowBackingEthereumPrincipalKey,
        ethereumHdIndex: EthereumBackerHdIndex
      },
      runInitializeEthereum
    )
  }

  /** Seed the full depot obligation even when existing custody needed no donation. */
  export async function runInitializeEthereum<C extends ClusterBuildContext>(
    ctx: C,
    input: EthereumBackingInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const step = EthereumSyndicationTool.planInitializeSyndication<C>(
      Report.Actor.EthereumOutpost, "InitializeEthereum", "seed mock shadow principal", {},
      input.ethereumHdIndex, ctx.outputs.assert(input.amountKey)
    )
    await step.runner(ctx, step.input, signal)
  }
}
