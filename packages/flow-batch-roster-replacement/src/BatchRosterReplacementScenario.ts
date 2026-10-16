import Assert from "node:assert"

import { PublicKey } from "@solana/web3.js"
import { PublicKey as SdkPublicKey } from "@wireio/sdk-core"
import { ethers } from "ethers"
import { OperatorType, OperatorStatus } from "@wireio/opp-typescript-models"
import {
  ClusterBuildPhase,
  DefaultBatchOperatorGroupCount,
  EthereumRoundTripScenario,
  EthereumOutpostBootstrapper,
  loadOutpostContract,
  EthereumSyndicationTool,
  OperatorDaemonTool,
  outputKey,
  pollUntil,
  ProtocolTiming,
  Report,
  SolanaOutpostBootstrapper,
  SolanaOutpostProgramTool,
  SyndicationScenario,
  verifyStep,
  WireCollateralTool,
  WireOperatorProvisioningTool,
  type ClusterBuild,
  type ClusterBuildContext
} from "@wireio/cluster-tool"

const { Actor } = Report

/** A funded nonbootstrap replacement must be consumed by both real outposts before user work. */
export class BatchRosterReplacementScenario extends EthereumRoundTripScenario {
  readonly name = "flow-batch-roster-replacement"
  readonly description =
    "A nonbootstrap batch replacement reaches both outposts and delivers fresh principal"
  override readonly defaults = {
    epochDurationSec: SyndicationScenario.EpochDurationSec,
    producerCount: 1,
    batchOperatorCount: DefaultBatchOperatorGroupCount,
    adHocCount: 1,
    operatorsPerEpoch: 1,
    batchOpGroups: DefaultBatchOperatorGroupCount,
    underwriterCount: 0,
    requiredBatchOperatorCollateral: [
      WireCollateralTool.createWireRequirement(
        BatchRosterReplacementScenario.Collateral
      )
    ]
  }

  protected override planBeforeIntake(cluster: ClusterBuild): void {
    WireOperatorProvisioningTool.planOperatorAccountProvisioning(
      cluster,
      "ProvisionReplacement",
      "Create a real nonbootstrap batch operator",
      {},
      [
        {
          label: BatchRosterReplacementScenario.Label,
          type: OperatorType.BATCH,
          ethereumHdIndex: BatchRosterReplacementScenario.ReplacementHdIndex,
          isBootstrapped: false,
          airdropSolanaLamports:
            WireOperatorProvisioningTool.DefaultSolanaAirdropLamports
        }
      ]
    )
    ClusterBuildPhase.create(
      cluster,
      "AdmitReplacement",
      "Bond the replacement and start its actual relay daemon"
    ).push(
      ...WireCollateralTool.planDeposit(
        Actor.BatchOperator,
        "bond-replacement",
        "meet the native depot admission minimum",
        SyndicationScenario.WriteOptions,
        BatchRosterReplacementScenario.Label,
        WireCollateralTool.createWireCollateral(
          BatchRosterReplacementScenario.Collateral
        )
      ),
      OperatorDaemonTool.planDaemonStart(
        Actor.BatchOperator,
        "start-replacement",
        "start replacement with its own real ETH and SOL signing keys",
        SyndicationScenario.VerifyOptions,
        BatchRosterReplacementScenario.Label
      ),
      verifyStep(
        Actor.BatchOperator,
        "both-outposts-consumed-replacement",
        "Ethereum authorizes the replacement for its next delivery; Solana installed its live key and group",
        async ctx => {
          await pollUntil(
            "replacement installed by both real outposts",
            async () => {
              const operator = ctx.keyStore.assertOperator(
                  BatchRosterReplacementScenario.Label
                ),
                inbound = BatchRosterReplacementScenario.inbound(ctx),
                ethereumEpoch = await inbound.nextEpochIndex(),
                ethereumAddress =
                  BatchRosterReplacementScenario.ethereumAddress(ctx),
                registry =
                  await BatchRosterReplacementScenario.solanaRegistry(ctx),
                solanaAddress =
                  BatchRosterReplacementScenario.solanaAddress(ctx)
              return (
                (await inbound.isActiveOperatorForEpoch(
                  ethereumAddress,
                  ethereumEpoch
                )) &&
                BatchRosterReplacementScenario.isInstalledSolanaReplacement(
                  registry,
                  solanaAddress
                ) &&
                !(await WireCollateralTool.readOperatorRow(ctx, operator.label))
                  .is_bootstrapped
              )
            },
            ProtocolTiming.DoubleHopBudgetMs,
            SyndicationScenario.PollMs
          )
          ctx.outputs.set(
            BatchRosterReplacementScenario.EthereumEpochBefore,
            Number(
              await BatchRosterReplacementScenario.inbound(ctx).nextEpochIndex()
            )
          )
          ctx.outputs.set(
            BatchRosterReplacementScenario.SolanaEpochBefore,
            (await BatchRosterReplacementScenario.solanaConfig(ctx))
              .nextEpochIndex
          )
        },
        {
          timeoutMs:
            ProtocolTiming.DoubleHopBudgetMs +
            ProtocolTiming.PollDeadlineBufferMs
        }
      )
    )
  }

  override plan(cluster: ClusterBuild): void {
    super.plan(cluster)
    ClusterBuildPhase.create(
      cluster,
      "ReplacementDelivered",
      "Require actual accepted relay work with both replacement signing identities"
    ).push(
      verifyStep(
        Actor.BatchOperator,
        "replacement-relayed-ethereum",
        "the replacement submitted an accepted Ethereum envelope after roster consumption",
        async ctx => {
          const inbound = BatchRosterReplacementScenario.inbound(ctx),
            last = Number(await inbound.nextEpochIndex()),
            first = ctx.outputs.assert(
              BatchRosterReplacementScenario.EthereumEpochBefore
            )
          let delivered = false
          for (let epoch = first; epoch < last; epoch++) {
            const digest = await inbound.epochDeliveries(
              epoch,
              BatchRosterReplacementScenario.ethereumAddress(ctx)
            )
            const accepted = await inbound.getInboundEnvelope(epoch)
            if (
              BatchRosterReplacementScenario.isAcceptedEthereumDelivery(
                epoch,
                digest,
                accepted
              )
            )
              delivered = true
          }
          Assert.ok(delivered, "replacement never delivered on Ethereum")
        }
      ),
      verifyStep(
        Actor.BatchOperator,
        "replacement-relayed-solana",
        "the replacement recorded the canonical vote for a fully dispatched post-roster Solana envelope",
        async ctx => {
          await pollUntil(
            "replacement accepted on Solana",
            async () => {
              const config =
                  await BatchRosterReplacementScenario.solanaConfig(ctx),
                accepted =
                  await BatchRosterReplacementScenario.solanaInbound(ctx),
                first = ctx.outputs.assert(
                  BatchRosterReplacementScenario.SolanaEpochBefore
                )
              for (const record of accepted.envelopes.filter(
                record =>
                  record.epochIndex >= first &&
                  record.epochIndex < config.nextEpochIndex
              )) {
                const deliveries =
                  await BatchRosterReplacementScenario.solanaDeliveries(
                    ctx,
                    record.epochIndex
                  )
                if (
                  deliveries &&
                  BatchRosterReplacementScenario.isAcceptedSolanaDelivery(
                    deliveries,
                    record,
                    BatchRosterReplacementScenario.solanaAddress(ctx)
                  )
                )
                  return true
              }
              return false
            },
            ProtocolTiming.SingleHopBudgetMs,
            SyndicationScenario.PollMs
          )
        },
        SyndicationScenario.VerifyOptions
      )
    )
  }
}

/** Real-chain consumer reads and bounded replacement constants. */
export namespace BatchRosterReplacementScenario {
  /** Nonbootstrap operator's durable key-store identity. */
  export const Label = "replacement"
  /** Funded anvil account distinct from user and bootstrap accounts. */
  export const ReplacementHdIndex = 33
  /** One WIRE meets the installed admission minimum. */
  export const Collateral = 1_000_000_000n
  /** Ethereum next inbound epoch once both registries consumed replacement. */
  export const EthereumEpochBefore = outputKey<number>(
    "BatchRosterReplacement.ethereumEpoch",
    "first replacement delivery epoch"
  )
  /** First Solana inbound epoch after both registries consumed replacement. */
  export const SolanaEpochBefore = outputKey<number>(
    "BatchRosterReplacement.solanaEpoch",
    "first replacement Solana delivery epoch"
  )
  /** Accepted Ethereum audit metadata decoded by the deployed ABI. */
  export interface AcceptedEthereumEnvelope {
    epochIndex: bigint
    checksum: string
  }
  /** Active operator fields consumed from the deployed Solana IDL. */
  export interface RegistryOperator {
    solAddress: PublicKey
    role: number
    status: number
  }
  /** Live members of one scheduled Solana group. */
  export interface RegistryGroup {
    memberCount: number
    members: PublicKey[]
  }
  /** One actual recorded Solana operator vote. */
  export interface SolanaOperatorDelivery {
    operator: PublicKey
    envelopeHash: number[]
  }
  /** Fully dispatched Solana destination cursor. */
  export interface SolanaConfigView {
    nextEpochIndex: number
  }
  /** Canonical accepted Solana envelope audit history. */
  export interface SolanaInboundView {
    envelopes: EnvelopeRecord[]
  }
  /** Typed reads from the deployed ABI; no handwritten function signatures. */
  export interface InboundView {
    nextEpochIndex(): Promise<bigint>
    isActiveOperatorForEpoch(address: string, epoch: bigint): Promise<boolean>
    epochDeliveries(epoch: number, address: string): Promise<string>
    getInboundEnvelope(epoch: number): Promise<AcceptedEthereumEnvelope>
  }
  /**
   * Load the real deployed inbound artifact and its typed reader surface.
   * @param ctx - The live cluster context and its deployed chain clients.
   * @returns Typed reads from the actual deployed inbound contract.
   */
  export function inbound(ctx: ClusterBuildContext): InboundView {
    return loadOutpostContract<InboundView>(
      ctx.config.ethereumPath,
      EthereumSyndicationTool.readDeployAddresses(
        ctx,
        EthereumOutpostBootstrapper.OutpostAddressesFile
      ),
      "OPPInbound",
      ["outpost"],
      ctx.ethereum.provider
    )
  }
  /**
   * Ethereum signing identity of the nonbootstrap daemon.
   * @param ctx - The live cluster context and its deployed chain clients.
   * @returns The replacement’s normalized Ethereum address.
   */
  export function ethereumAddress(ctx: ClusterBuildContext): string {
    const address = ctx.keyStore.assertOperator(Label).ethereum.address
    return address.startsWith("0x") ? address : `0x${address}`
  }
  /**
   * Solana signing identity of the same nonbootstrap daemon.
   * @param ctx - The live cluster context and its deployed chain clients.
   * @returns The replacement’s Solana public key.
   */
  export function solanaAddress(ctx: ClusterBuildContext): PublicKey {
    return new PublicKey(
      SdkPublicKey.from(ctx.keyStore.assertOperator(Label).solana.publicKey)
        .data.array
    )
  }
  /** Live-window fields decoded using the deployed program's own generated IDL. */
  export interface RegistryView {
    operatorCount: number
    groupCount: number
    operators: RegistryOperator[]
    groups: RegistryGroup[]
  }
  /**
   * Require the live ACTIVE batch entry and a sole-member replacement group.
   * @param registry - The decoded registry including its live member counts.
   * @param address - The replacement’s native signing address.
   * @returns Whether both live membership and the sole-member group contain the active replacement.
   */
  export function isInstalledSolanaReplacement(
    registry: RegistryView,
    address: PublicKey
  ): boolean {
    return (
      registry.operators
        .slice(0, registry.operatorCount)
        .some(
          entry =>
            entry.solAddress.equals(address) &&
            entry.role === OperatorType.BATCH &&
            entry.status === OperatorStatus.ACTIVE
        ) &&
      registry.groups
        .slice(0, registry.groupCount)
        .some(
          group => group.memberCount === 1 && group.members[0].equals(address)
        )
    )
  }
  /**
   * A submitted digest counts only when it equals the canonical accepted envelope.
   * @param epoch - The inbound epoch whose accepted delivery must be proved.
   * @param digest - The replacement’s recorded Ethereum delivery digest.
   * @param accepted - The canonical accepted envelope audit record.
   * @returns Whether the replacement’s vote matches the accepted canonical envelope.
   */
  export function isAcceptedEthereumDelivery(
    epoch: number,
    digest: string,
    accepted: AcceptedEthereumEnvelope
  ): boolean {
    return (
      digest !== ethers.ZeroHash &&
      Number(accepted.epochIndex) === epoch &&
      accepted.checksum === digest
    )
  }
  /** Canonical audit entry decoded from the program's generated envelope-log IDL. */
  export interface EnvelopeRecord {
    epochIndex: number
    checksum: number[]
  }
  /** Actual on-chain votes; chunk staging and stale retries do not write these records. */
  export interface SolanaDeliveries {
    epochIndex: number
    consensusReached: boolean
    consensusHash: number[]
    deliveries: SolanaOperatorDelivery[]
  }
  /**
   * Only the replacement's canonical consensus vote proves accepted delivery.
   * @param deliveries - The epoch’s actual recorded Solana votes and consensus state.
   * @param accepted - The canonical accepted envelope audit record.
   * @param signer - The replacement’s Solana signing key.
   * @returns Whether the replacement’s canonical vote matches accepted consensus.
   */
  export function isAcceptedSolanaDelivery(
    deliveries: SolanaDeliveries,
    accepted: EnvelopeRecord,
    signer: PublicKey
  ): boolean {
    return (
      deliveries.epochIndex === accepted.epochIndex &&
      deliveries.consensusReached &&
      Buffer.from(deliveries.consensusHash).equals(
        Buffer.from(accepted.checksum)
      ) &&
      deliveries.deliveries.some(
        delivery =>
          delivery.operator.equals(signer) &&
          Buffer.from(delivery.envelopeHash).equals(
            Buffer.from(accepted.checksum)
          )
      )
    )
  }
  /**
   * Read the destination's fully-dispatched epoch cursor using its own account coder.
   * @param ctx - The live cluster context and its deployed chain clients.
   * @returns The decoded destination epoch cursor.
   */
  export async function solanaConfig(
    ctx: ClusterBuildContext
  ): Promise<SolanaConfigView> {
    const value = await readSolanaAccount<SolanaConfigView>(
      ctx,
      "outpostConfig",
      [Buffer.from(SolanaOutpostBootstrapper.PdaSeed.OutpostConfig)]
    )
    Assert.ok(value, "Solana outpost config missing")
    return value
  }
  /**
   * Read the canonical accepted envelope audit trail, independently of transaction success.
   * @param ctx - The live cluster context and its deployed chain clients.
   * @returns The canonical accepted inbound envelope audit trail.
   */
  export async function solanaInbound(
    ctx: ClusterBuildContext
  ): Promise<SolanaInboundView> {
    const value = await readSolanaAccount<SolanaInboundView>(
      ctx,
      "envelopeLog",
      [Buffer.from(SolanaOutpostBootstrapper.PdaSeed.InboundEnvelopes)]
    )
    Assert.ok(value, "Solana inbound envelope log missing")
    return value
  }
  /**
   * Read one epoch's actual recorded votes, not successful chunk staging transactions.
   * @param ctx - The live cluster context and its deployed chain clients.
   * @param epoch - The inbound epoch whose accepted delivery must be proved.
   * @returns The recorded epoch votes, or undefined when no delivery exists.
   */
  export async function solanaDeliveries(
    ctx: ClusterBuildContext,
    epoch: number
  ): Promise<SolanaDeliveries> {
    const index = Buffer.alloc(Uint32Array.BYTES_PER_ELEMENT)
    index.writeUInt32LE(epoch)
    return readSolanaAccount<SolanaDeliveries>(ctx, "epochDeliveries", [
      Buffer.from(SolanaOutpostBootstrapper.PdaSeed.EpochDeliveries),
      index
    ])
  }
  /**
   * Load an account through the deployed IDL; absent epoch votes remain absent evidence.
   * @param ctx - The live cluster context and its deployed chain clients.
   * @param accountName - The value used by this scenario.
   * @param seeds - The value used by this scenario.
   */
  async function readSolanaAccount<T>(
    ctx: ClusterBuildContext,
    accountName: string,
    seeds: Buffer[]
  ): Promise<T> {
    const program = SolanaOutpostProgramTool.loadReadOnlyProgram(
        ctx.solana.connection,
        ctx.config.solanaPath
      ),
      address = SolanaOutpostProgramTool.derivePda(program.programId, ...seeds),
      account = await ctx.solana.connection.getAccountInfo(address)
    return account
      ? program.coder.accounts.decode<T>(accountName, account.data)
      : undefined
  }
  /**
   * Read the actual registry PDA and decode only its live member windows.
   * @param ctx - The live cluster context and its deployed chain clients.
   * @returns The deployed program’s decoded operator registry.
   */
  export async function solanaRegistry(
    ctx: ClusterBuildContext
  ): Promise<RegistryView> {
    const program = SolanaOutpostProgramTool.loadReadOnlyProgram(
        ctx.solana.connection,
        ctx.config.solanaPath
      ),
      address = SolanaOutpostProgramTool.derivePda(
        program.programId,
        Buffer.from(SolanaOutpostBootstrapper.PdaSeed.OperatorRegistry)
      ),
      account = await ctx.solana.connection.getAccountInfo(address)
    Assert.ok(account, "Solana operator registry missing")
    return program.coder.accounts.decode<RegistryView>(
      "operatorRegistry",
      account.data
    )
  }
}
