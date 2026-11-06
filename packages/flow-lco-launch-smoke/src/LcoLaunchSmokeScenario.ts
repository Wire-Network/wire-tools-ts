import Assert from "node:assert"

import { ChainKind } from "@wireio/opp-typescript-models"
import { Base58, PrivateKey, PublicKey, SysioContracts } from "@wireio/sdk-core"
import {
  AuthExLinkTool,
  ClusterBuildPhase,
  ClusterBuildStep,
  Constants,
  convertImportSeed,
  EthereumSyndicationTool,
  FlowScenario,
  formatWireAsset,
  outputKey,
  Report,
  Steps,
  SyndicationScenario,
  SyndicationUserSteps,
  WireSyndicationTool,
  abiEnumValue,
  verifyStep,
  type ClusterBuild,
  type ClusterBuildContext,
  type ImportSeedChainKind,
  type StepInput
} from "@wireio/cluster-tool"

const { Actor } = Report
const { SysioContractName, SysioContractAccount } = SysioContracts

/** Compact launch acceptance for both external identity types, without a soak. */
export class LcoLaunchSmokeScenario extends FlowScenario {
  readonly name = "flow-lco-launch-smoke"
  readonly description =
    "Original ETH and SOL wallets receive backed principal and exact purchased/yield WIRE entitlements"
  override readonly defaults = {
    epochDurationSec: SyndicationScenario.EpochDurationSec,
    producerCount: 1,
    batchOperatorCount: 1,
    operatorsPerEpoch: 1,
    batchOpGroups: 1,
    underwriterCount: 0,
    enableMockSyndicationImport: true
  }

  plan(cluster: ClusterBuild): void {
    ClusterBuildPhase.create(
      cluster,
      "FundClaims",
      "Fund the two controlled launch obligations"
    ).push(
      Steps.contracts.sysio.token.planTransfer(
        Actor.Sysio,
        "fund-lco-claims",
        "fund exact controlled entitlement total",
        SyndicationScenario.WriteOptions,
        {
          from: SysioContractAccount[SysioContractName.system],
          to: SysioContractAccount[SysioContractName.dclaim],
          quantity: formatWireAsset(LcoLaunchSmokeScenario.Entitlement * 2n),
          memo: "controlled LCO launch smoke"
        }
      )
    )
    const imports = ClusterBuildPhase.create(
      cluster,
      "ImportLaunchEntitlements",
      "Convert both production-format records and close the launch import window"
    )
    for (const chain of LcoLaunchSmokeScenario.Chains) {
      imports.push(
        LcoLaunchSmokeScenario.planAction(
          `import-${LcoLaunchSmokeScenario.account(chain)}`,
          "convert and import one purchased/yield index record",
          chain,
          LcoLaunchSmokeScenario.runImport
        )
      )
    }
    imports.push(
      ClusterBuildStep.create(
        Actor.Sysio,
        "close-launch-import",
        "close the import window before participants link and claim",
        SyndicationScenario.WriteOptions,
        null,
        LcoLaunchSmokeScenario.runImportDone
      )
    )
    for (const chain of LcoLaunchSmokeScenario.Chains) {
      const account = LcoLaunchSmokeScenario.account(chain),
        phase = ClusterBuildPhase.create(
          cluster,
          `Recover-${account}`,
          "Convert production-format index rows and authenticate their original wallet"
        )
      phase.push(
        Steps.account.planCreateKeyed(
          Actor.User,
          `create-${account}`,
          "create participant destination",
          SyndicationScenario.WriteOptions,
          account,
          Constants.DEV_K1_PUBLIC_KEY
        ),
        SyndicationUserSteps.planResourcePolicy(
          Actor.User,
          `resource-${account}`,
          "allocate claim and link resources",
          SyndicationScenario.WriteOptions,
          SyndicationScenario.resourcePolicy(account)
        ),
        verifyStep(
          Actor.User,
          `before-link-${account}`,
          "record WIRE baseline and confirm imported principal is still parked",
          async ctx => {
            ctx.outputs.set(
              LcoLaunchSmokeScenario.beforeKey(chain),
              await ctx.wire.getWireBalance(account)
            )
            Assert.strictEqual(
              await LcoLaunchSmokeScenario.principal(ctx, chain),
              0n
            )
            const bonder = Steps.registry.readMockSyndicationBonder(ctx),
              key = chain === ChainKind.EVM ? bonder.ethereum : bonder.solana
            const parked = await WireSyndicationTool.readParked(
              ctx,
              LcoLaunchSmokeScenario.token(chain),
              chain === ChainKind.EVM
                ? SysioContracts.SysioSyndChainkind.CHAIN_KIND_EVM
                : SysioContracts.SysioSyndChainkind.CHAIN_KIND_SVM,
              PublicKey.from(key.publicKey).data.hexString
            )
            Assert.ok(parked, "missing backed imported principal")
            Assert.strictEqual(
              BigInt(parked.balance),
              BigInt(Steps.registry.MockSyndicationImportAmount)
            )
          }
        ),
        LcoLaunchSmokeScenario.planAction(
          `link-${account}`,
          "authenticate the exact original wallet used by both imports",
          chain,
          LcoLaunchSmokeScenario.runLink
        ),
        verifyStep(
          Actor.User,
          `principal-${account}`,
          "original-wallet link sweeps all backed imported principal",
          async ctx => {
            Assert.strictEqual(
              await LcoLaunchSmokeScenario.principal(ctx, chain),
              BigInt(Steps.registry.MockSyndicationImportAmount)
            )
          }
        ),
        LcoLaunchSmokeScenario.planAction(
          `claim-${account}`,
          "claim purchased pretokens and staking yield",
          chain,
          LcoLaunchSmokeScenario.runClaim
        ),
        verifyStep(
          Actor.User,
          `entitlement-${account}`,
          "WIRE delta equals purchased pretokens plus staking rewards exactly",
          async ctx => {
            Assert.strictEqual(
              (await ctx.wire.getWireBalance(account)) -
                ctx.outputs.assert(LcoLaunchSmokeScenario.beforeKey(chain)),
              LcoLaunchSmokeScenario.Entitlement
            )
            Assert.strictEqual(
              await LcoLaunchSmokeScenario.principal(ctx, chain),
              BigInt(Steps.registry.MockSyndicationImportAmount)
            )
          }
        )
      )
    }
  }
}

/** Constants, source conversion, and one-write runners for launch acceptance. */
export namespace LcoLaunchSmokeScenario {
  /** Both external account kinds shipped at launch. */
  export const Chains: readonly ImportSeedChainKind[] = [
    ChainKind.EVM,
    ChainKind.SVM
  ]
  /** Controlled purchased principal expressed in WIRE atomic units. */
  export const Purchased = 2_000_000_000n
  /** Controlled accumulated staking reward expressed in WIRE atomic units. */
  export const Yield = 1_000_000_000n
  /** The exact combined entitlement expected from each wallet. */
  export const Entitlement = Purchased + Yield
  /** Original holder's WIRE balance, independently captured per chain. */
  const EthereumBefore = outputKey<bigint>(
    "LcoLaunchSmoke.ethereumBefore",
    "Ethereum WIRE balance before claim"
  )
  const SolanaBefore = outputKey<bigint>(
    "LcoLaunchSmoke.solanaBefore",
    "Solana WIRE balance before claim"
  )
  /**
   * Output slot for the original wallet's balance.
   * @param chain - The original external wallet’s supported chain kind.
   * @returns The original wallet’s balance snapshot output slot.
   */
  export function beforeKey(chain: ImportSeedChainKind) {
    return chain === ChainKind.EVM ? EthereumBefore : SolanaBefore
  }
  /**
   * Distinct destinations keep both identity journeys independently accountable.
   * @param chain - The original external wallet’s supported chain kind.
   * @returns The chain-specific WIRE destination account.
   */
  export function account(chain: ImportSeedChainKind): string {
    return chain === ChainKind.EVM ? "lco.eth" : "lco.sol"
  }
  /**
   * Each native identity owns its matching backed imported shadow.
   * @param chain - The original external wallet’s supported chain kind.
   * @returns The chain-specific shadow token codename.
   */
  export function token(chain: ImportSeedChainKind): string {
    return chain === ChainKind.EVM ? "LIQETH" : "LIQSOL"
  }
  /** One native action, selected by its explicit runner. */
  export interface ActionInput extends StepInput {
    readonly kind: "LcoLaunchSmokeScenario.ActionInput"
    readonly chain: ImportSeedChainKind
  }
  /**
   * Plan one import, link or claim, with no hidden writes.
   * @param name - The report step name.
   * @param description - The outcome described by the report row.
   * @param chain - The original external wallet’s supported chain kind.
   * @param runner - The named runner performing exactly one action.
   * @returns One reported native write step.
   */
  export function planAction(
    name: string,
    description: string,
    chain: ImportSeedChainKind,
    runner: (
      ctx: ClusterBuildContext,
      input: ActionInput,
      signal: AbortSignal
    ) => Promise<void>
  ) {
    return ClusterBuildStep.create(
      Actor.User,
      name,
      description,
      SyndicationScenario.WriteOptions,
      { kind: "LcoLaunchSmokeScenario.ActionInput", chain },
      runner
    )
  }
  /**
   * Convert a real-shaped purchaser and staker row sharing the controlled native address.
   * @param ctx - The live cluster context and its deployed chain clients.
   * @param chain - The original external wallet’s supported chain kind.
   * @returns The production converter’s exact entitlement batches.
   */
  export function conversion(
    ctx: ClusterBuildContext,
    chain: ImportSeedChainKind
  ) {
    const bonder = Steps.registry.readMockSyndicationBonder(ctx),
      address =
        chain === ChainKind.EVM
          ? `0x${bonder.ethereum.address.replace(/^0x/, "")}`
          : Base58.encode(PublicKey.from(bonder.solana.publicKey).data.array),
      scale = chain === ChainKind.EVM ? 1_000_000_000n : 1n
    return convertImportSeed(
      {
        purchasers: [{ address, totalPretokens: String(Purchased * scale) }],
        stakers: [
          { address, pretokenYield: String(Yield * scale), yieldClaimed: "0" }
        ]
      },
      { chain }
    )
  }
  /**
   * Import exactly one converted index batch, without bypassing production conversion.
   * @param ctx - The live cluster context and its deployed chain clients.
   * @param input - The reported step input.
   * @param signal - Cancellation signal for the reported action.
   */
  export async function runImport(
    ctx: ClusterBuildContext,
    input: ActionInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const result = conversion(ctx, input.chain)
    Assert.strictEqual(result.batches.length, 1)
    Assert.strictEqual(result.batches[0].credits.length, 1)
    Assert.strictEqual(result.batches[0].credits[0].wire_atomic, Entitlement)
    await ctx.wire
      .getSysioContract(SysioContractName.dclaim)
      .actions.importseed.invoke({
        chain: abiEnumValue(SysioContracts.SysioDclaimChainkind, input.chain),
        credits: result.batches[0].credits.map(credit => ({
          native_address: credit.native_address,
          wire_atomic: String(credit.wire_atomic)
        }))
      })
  }
  /**
   * Close the production import window with its ordinary contract action.
   * @param ctx - The live cluster context and its deployed chain clients.
   * @param _input - The reported step input; this action needs no additional payload.
   * @param signal - Cancellation signal for the reported action.
   */
  export async function runImportDone(
    ctx: ClusterBuildContext,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.dclaim)
      .actions.importdone.invoke({})
  }
  /**
   * Authenticate the original bootstrap-import wallet and trigger its ordinary inline sweeps.
   * @param ctx - The live cluster context and its deployed chain clients.
   * @param input - The reported step input.
   * @param signal - Cancellation signal for the reported action.
   */
  export async function runLink(
    ctx: ClusterBuildContext,
    input: ActionInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    if (input.chain === ChainKind.SVM) {
      await SyndicationUserSteps.runLinkSolanaKey(
        ctx,
        {
          kind: "SyndicationUserSteps.LinkSolanaKeyInput",
          account: account(input.chain),
          keypairName: Steps.registry.MockSyndicationBonderLabel
        },
        signal
      )
    } else {
      const bonder = Steps.registry.readMockSyndicationBonder(ctx),
        wallet = EthereumSyndicationTool.hdWallet(
          ctx,
          Steps.registry.MockSyndicationBonderEthereumHdIndex
        )
      Assert.strictEqual(
        wallet.address.toLowerCase(),
        `0x${bonder.ethereum.address.replace(/^0x/, "")}`.toLowerCase(),
        "LCO original Ethereum wallet does not match imported identity"
      )
      await AuthExLinkTool.createLink(ctx.wire, {
        chainKind: input.chain,
        account: account(input.chain),
        privateKey: PrivateKey.from(bonder.ethereum.privateKey),
        ethereumWallet: wallet
      })
    }
  }
  /**
   * Claim the controlled original wallet's exact pending WIRE obligation.
   * @param ctx - The live cluster context and its deployed chain clients.
   * @param input - The reported step input.
   * @param signal - Cancellation signal for the reported action.
   */
  export async function runClaim(
    ctx: ClusterBuildContext,
    input: ActionInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.dclaim)
      .actions.claim.invoke(
        { wire_account: account(input.chain) },
        {
          authorization: [{ actor: account(input.chain), permission: "active" }]
        }
      )
  }
  /**
   * Read the user's actual principal, with no floating-point conversion or truncated reads.
   * @param ctx - The live cluster context and its deployed chain clients.
   * @param chain - The original external wallet’s supported chain kind.
   * @returns The actual imported principal in the participant’s destination wallet.
   */
  export async function principal(
    ctx: ClusterBuildContext,
    chain: ImportSeedChainKind
  ): Promise<bigint> {
    return WireSyndicationTool.readLiqBalance(ctx, account(chain), token(chain))
  }
}
