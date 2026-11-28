import Assert from "node:assert"

import {
  MessageAccountKeys,
  PublicKey,
  type VersionedTransactionResponse
} from "@solana/web3.js"
import { PublicKey as SdkPublicKey } from "@wireio/sdk-core"
import { ethers } from "ethers"
import { OperatorType, OperatorStatus } from "@wireio/opp-typescript-models"
import type { SysioContracts } from "@wireio/sdk-core"
import {
  ClusterBuildPhase,
  Constants,
  DefaultBatchOperatorGroupCount,
  EthereumRoundTripScenario,
  EthereumOutpostBootstrapper,
  loadOutpostContract,
  EthereumSyndicationTool,
  mapSeries,
  OperatorDaemonTool,
  outputKey,
  ProtocolTiming,
  Report,
  SolanaClient,
  SolanaOutpostBootstrapper,
  Steps,
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
          isBootstrapped: false,
          // Fee-payer funding for the daemon's deliveries on BOTH outposts: every key is
          // random and starts at zero, and an unfunded Ethereum fee payer never delivers.
          fundEthereumWei: WireOperatorProvisioningTool.DefaultEthereumFundWei,
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
      verifyStep(
        Actor.Sysio,
        "record-roster-sent",
        "record the roster hash each outpost was last queued (sysio.epoch::rostersent) before the replacement is admitted",
        async ctx => {
          ctx.outputs.set(
            BatchRosterReplacementScenario.RosterHashesBefore,
            BatchRosterReplacementScenario.rosterHashes(
              await Steps.contracts.sysio.epoch.readRostersSent(ctx)
            )
          )
        }
      ),
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
        "the depot queued the changed roster to both outposts by itself (rostersent, never erased by the pump); Ethereum authorizes the replacement for its next delivery; Solana installed its live key and group",
        async (ctx, signal) => {
          // The pump gives traffic with notetraffic, which leaves rostersent alone, so every roster the
          // outposts receive here was queued by the depot's own diff against rostersent: a row erased
          // mid-wait (a resendroster) would mask a roster-propagation regression and fails at once.
          const rosterHashesBefore = ctx.outputs.assert(
            BatchRosterReplacementScenario.RosterHashesBefore
          )
          await Steps.epochAdvance.pollUntilKeepingDue(
            ctx,
            BatchRosterReplacementScenario.OutpostChains,
            "replacement installed by both real outposts",
            async () => {
              BatchRosterReplacementScenario.assertRosterSentKept(
                await Steps.contracts.sysio.epoch.readRostersSent(ctx)
              )
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
            SyndicationScenario.PollMs,
            signal
          )
          BatchRosterReplacementScenario.assertRostersRequeued(
            rosterHashesBefore,
            await Steps.contracts.sysio.epoch.readRostersSent(ctx)
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
        async (ctx, signal) => {
          // The replacement's group comes on duty only as Ethereum advances, so the wait keeps
          // Ethereum due with governance traffic until one of its epochs carries an accepted
          // delivery by the replacement.
          await Steps.epochAdvance.pollUntilKeepingDue(
            ctx,
            [Constants.ETHEREUM_CHAIN_CODENAME],
            "replacement accepted on Ethereum",
            async () => {
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
              return delivered
            },
            ProtocolTiming.SingleHopBudgetMs,
            SyndicationScenario.PollMs,
            signal
          )
        },
        SyndicationScenario.VerifyOptions
      ),
      verifyStep(
        Actor.BatchOperator,
        "replacement-relayed-solana",
        "the replacement's own terminal epoch_in delivered a post-roster Solana envelope the outpost accepted and fully dispatched",
        async (ctx, signal) => {
          await Steps.epochAdvance.pollUntilKeepingDue(
            ctx,
            [Constants.SOLANA_CHAIN_CODENAME],
            "replacement accepted on Solana",
            async () => {
              const config =
                  await BatchRosterReplacementScenario.solanaConfig(ctx),
                first = ctx.outputs.assert(
                  BatchRosterReplacementScenario.SolanaEpochBefore
                ),
                settled = (
                  await BatchRosterReplacementScenario.solanaInbound(ctx)
                ).envelopes
                  .map(record => record.epochIndex)
                  .filter(
                    epoch => epoch >= first && epoch < config.nextEpochIndex
                  )
              if (settled.length === 0) return false
              // The relay reaps a settled epoch's EpochDeliveries tally within seconds, so the
              // delivery is read from the replacement's own transactions, which outlive it.
              const delivered =
                await BatchRosterReplacementScenario.readSolanaDeliveredEpochs(
                  ctx
                )
              return settled.some(epoch => delivered.includes(epoch))
            },
            ProtocolTiming.SingleHopBudgetMs,
            SyndicationScenario.PollMs,
            signal
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
  /** The two real outposts the replacement must reach, in the order the flow checks them. */
  export const OutpostChains = [
    Constants.ETHEREUM_CHAIN_CODENAME,
    Constants.SOLANA_CHAIN_CODENAME
  ] as const
  /** One value per outpost chain the replacement must reach. */
  export type PerChain<T> = Record<(typeof OutpostChains)[number], T>
  /**
   * The roster hash each outpost was last queued (`sysio.epoch::rostersent`) before the
   * replacement was admitted; absent for a chain no roster had been queued to.
   */
  export const RosterHashesBefore = outputKey<PerChain<string>>(
    "BatchRosterReplacement.rosterHashesBefore",
    "each outpost's last-queued roster hash before the replacement is admitted"
  )
  /**
   * Each outpost chain's last-queued roster hash from one `rostersent` read — pure.
   * @param rows - Each chain's `rostersent` row (`EpochContractSteps.readRostersSent`).
   * @returns Each chain's `roster_hash`, absent for a chain without a row.
   */
  export function rosterHashes(
    rows: Readonly<PerChain<SysioContracts.SysioEpochRosterSentType>>
  ): PerChain<string> {
    return Object.fromEntries(
      OutpostChains.map(chain => [chain, rows[chain]?.roster_hash])
    ) as PerChain<string>
  }
  /**
   * Every outpost chain still has its `rostersent` row — pure. Only governance `resendroster`
   * erases one, and the keep-due pump never pushes it, so a missing row means something re-shipped
   * the roster regardless of a diff and would mask a roster-propagation regression.
   * @param rows - Each chain's `rostersent` row.
   * @throws When a chain has no row.
   */
  export function assertRosterSentKept(
    rows: Readonly<PerChain<SysioContracts.SysioEpochRosterSentType>>
  ): void {
    OutpostChains.forEach(chain =>
      Assert.ok(
        rows[chain] != null,
        `sysio.epoch::rostersent lost its ${chain} row: the roster was resent rather than queued by its diff`
      )
    )
  }
  /**
   * The depot queued the changed roster to every outpost by itself — pure: each chain's
   * `rostersent` row is present (never erased, {@link assertRosterSentKept}) and its hash differs
   * from the one recorded before the replacement was admitted, so an advance's own diff found the
   * roster changed and queued it.
   * @param before - Each chain's hash before the admission ({@link RosterHashesBefore}).
   * @param after - Each chain's `rostersent` row now.
   * @throws When a row is missing or a chain's roster hash did not change.
   */
  export function assertRostersRequeued(
    before: Readonly<PerChain<string>>,
    after: Readonly<PerChain<SysioContracts.SysioEpochRosterSentType>>
  ): void {
    assertRosterSentKept(after)
    OutpostChains.forEach(chain =>
      Assert.notStrictEqual(
        after[chain].roster_hash,
        before[chain],
        `the depot never queued a changed roster to the ${chain} outpost: rostersent still holds ${before[chain]}`
      )
    )
  }
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
  /** The outpost's delivery instruction (`epoch_in`), as the deployed program's coder names it. */
  export const EpochInMethodName = "epochIn"
  /** The {@link EpochInMethodName} account that signs the delivery. */
  export const EpochInOperatorAccount = "operator"
  /** Newest signatures of the replacement's Solana key the delivery read decodes: one RPC page. */
  export const SolanaSignatureScanLimit = 1_000
  /** `epoch_in`'s arguments the delivery read consumes, as the deployed program's coder decodes them. */
  export interface EpochInArguments {
    epochIndex: number
    chunkIndex: number
    totalChunks: number
  }
  /**
   * The epochs `signer` delivered in one confirmed transaction: its instructions to the program,
   * decoded by the program's own coder, that are a terminal `epoch_in` (`chunkIndex ==
   * totalChunks`, the call that records a delivery; data chunks only stage bytes) with `signer`
   * as the `operator` account.
   * @param response - The confirmed transaction.
   * @param program - The deployed outpost program.
   * @param signer - The replacement's Solana signing key.
   * @returns The delivered epochs.
   */
  export function deliveredEpochsOf(
    response: VersionedTransactionResponse,
    program: ReturnType<typeof SolanaOutpostProgramTool.loadReadOnlyProgram>,
    signer: PublicKey
  ): number[] {
    const epochIn = program.idl.instructions.find(
      instruction => instruction.name === EpochInMethodName
    )
    Assert.ok(epochIn, `the outpost IDL has no ${EpochInMethodName} instruction`)
    const { message } = response.transaction,
      keys = new MessageAccountKeys(
        message.staticAccountKeys,
        response.meta.loadedAddresses
      ),
      operatorAccount = epochIn.accounts.findIndex(
        account => account.name === EpochInOperatorAccount
      )
    return message.compiledInstructions
      .filter(
        instruction =>
          keys.get(instruction.programIdIndex)?.equals(program.programId) &&
          keys.get(instruction.accountKeyIndexes[operatorAccount])?.equals(signer)
      )
      .map(instruction =>
        SolanaOutpostProgramTool.decodeInstruction(
          program,
          Buffer.from(instruction.data)
        )
      )
      .filter(decoded => decoded?.name === EpochInMethodName)
      .map(decoded => decoded.data as EpochInArguments)
      .filter(call => call.chunkIndex === call.totalChunks)
      .map(call => call.epochIndex)
  }
  /**
   * The epochs the replacement delivered on Solana, from its own successful transactions (the
   * newest {@link SolanaSignatureScanLimit}), which outlive each settled epoch's reaped
   * `EpochDeliveries` tally.
   * @param ctx - The live cluster context and its deployed chain clients.
   * @returns The delivered epochs.
   * @throws When a confirmed transaction of the replacement is unavailable.
   */
  export async function readSolanaDeliveredEpochs(
    ctx: ClusterBuildContext
  ): Promise<number[]> {
    const { connection } = ctx.solana,
      program = SolanaOutpostProgramTool.loadReadOnlyProgram(
        connection,
        ctx.config.solanaPath
      ),
      signer = solanaAddress(ctx),
      signatures = (
        await connection.getSignaturesForAddress(
          signer,
          { limit: SolanaSignatureScanLimit },
          SolanaClient.ConfirmationStatus.confirmed
        )
      ).filter(info => info.err == null),
      delivered = await mapSeries(signatures, async info => {
        const response = await connection.getTransaction(info.signature, {
          commitment: SolanaClient.ConfirmationStatus.confirmed,
          maxSupportedTransactionVersion: 0
        })
        Assert.ok(
          response != null,
          `Solana transaction ${info.signature} of the replacement is unavailable`
        )
        return deliveredEpochsOf(response, program, signer)
      })
    return delivered.flat()
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
   * Load an account through the deployed IDL; an absent account reads as undefined.
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
