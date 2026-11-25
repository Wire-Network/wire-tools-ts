import Assert from "node:assert"

import type { IdlAccounts } from "@coral-xyz/anchor"
import { PublicKey } from "@solana/web3.js"
import type { LiqsolCore } from "@wireio/outpost-solana-artifacts"
import { Checksum256, SlugName, SysioContracts } from "@wireio/sdk-core"
import { getLogger } from "@wireio/shared"
import {
  BatchOperatorUnderwritingSteps as UnderwritingSteps,
  NodeConfig,
  SolanaClient,
  SolanaOutpostBootstrapper,
  SolanaOutpostProgramTool,
  SolanaOutpostTarget,
  StepExtraRecorder,
  Steps,
  SyndicationScenario,
  WireSyndicationTool,
  matchesProtoEnum,
  pollUntil,
  type ClusterBuildContext
} from "@wireio/cluster-tool"

import { SyndicationPluginUnderwritingRecoveryScenarioConstants as Constants } from "../SyndicationPluginUnderwritingRecoveryScenarioConstants.js"
import { OriginalEnvelope, PrunedCheckpoint, PrunedSourceLog } from "../orchestration/index.js"

const log = getLogger(__filename)

/** Read-only evidence for the offline-underwriter recovery experiment. */
export namespace SyndicationPluginUnderwritingRecoverySteps {
  /** Account shape derived from the producer's generated Anchor IDL. */
  export type EnvelopeLog = IdlAccounts<LiqsolCore>["envelopeLog"]

  /**
   * Select the first bootstrap operator, which the funding configuration funds.
   * @param ctx - The planned cluster.
   * @returns The one node whose absence prevents every possible bond.
   */
  export function fundedNode(ctx: ClusterBuildContext): NodeConfig {
    const nodes = NodeConfig.batchOperatorNodes(ctx.config)
    Assert.strictEqual(nodes.length, Constants.BatchOperatorCount)
    Assert.strictEqual(ctx.config.batchOperatorUnderwriting.fundedOperatorCount, Constants.FundedOperatorCount)
    return nodes[0]
  }

  /**
   * Read the real finalized source account; no debugging archive supplies this proof.
   * @param ctx - The cluster with its deployed Solana program.
   * @returns The decoded on-chain outbound log.
   */
  export async function readOutboundLog(ctx: ClusterBuildContext): Promise<EnvelopeLog> {
    const target = SolanaOutpostTarget.fromContext(ctx),
      [address] = PublicKey.findProgramAddressSync([
        Buffer.from(SolanaOutpostBootstrapper.PdaSeed.OutboundEnvelopes)
      ], target.programId),
      account = await target.connection.getAccountInfo(address, SolanaClient.ConfirmationStatus.finalized)
    Assert.ok(account, "missing finalized outbound EnvelopeLog")
    Assert.ok(account.owner.equals(target.programId), "outbound log has the wrong program owner")
    return SolanaOutpostProgramTool.loadReadOnlyProgram(
      target.connection, target.solanaPath, SolanaOutpostProgramTool.ProgramName, target.programId
    ).coder.accounts.decode<EnvelopeLog>(Constants.EnvelopeLogAccountName, account.data)
  }

  /**
   * Refuse a request that received any coverage while the sole funded provider was absent.
   * @param request - The original request read from the depot.
   * @param bonds - Every bond on that request.
   */
  export function assertUnbonded(
    request: SysioContracts.SysioBondRequestRowType,
    bonds: readonly SysioContracts.SysioBondBondRowType[]
  ): void {
    Assert.ok(request, "the delayed request disappeared")
    Assert.ok(matchesProtoEnum(request.state, SysioContracts.SysioBondRequestState,
      SysioContracts.SysioBondRequestState.OPEN), "the delayed request is no longer OPEN")
    Assert.strictEqual(BigInt(request.bonded), 0n, "the request was bonded before recovery")
    Assert.deepStrictEqual(bonds, [], "a provider bonded while the funded node was absent")
  }

  /**
   * Verify one offline observation and the immutable accepted-envelope identity.
   * @param ctx - The live cluster and captured original row.
   */
  export async function assertStillUnbonded(ctx: ClusterBuildContext): Promise<void> {
    const { Plan } = Constants,
      node = fundedNode(ctx),
      operator = ctx.keyStore.assertOperator(node.batchOperatorLabel),
      requestId = ctx.outputs.assert(Plan.firstRequest),
      original = ctx.outputs.assert(OriginalEnvelope),
      current = await SyndicationScenario.readEnvelope(ctx, Plan.firstEpoch)
    Assert.ok(current, "the accepted syndication envelope disappeared")
    Assert.strictEqual(operator.account, UnderwritingSteps.fundedOperatorAccounts(ctx)[0])
    Assert.strictEqual(ctx.processManager.get(node.name), null, "the funded node is still running")
    Assert.deepStrictEqual(
      [current.chain_code, current.token_code, current.epoch_index, current.digest, String(current.request_id)],
      [original.chain_code, original.token_code, original.epoch_index, original.digest, String(original.request_id)],
      "the accepted syndication identity changed during the outage"
    )
    assertUnbonded(await WireSyndicationTool.readRequest(ctx, requestId),
      await WireSyndicationTool.readBonds(ctx, requestId))
    await UnderwritingSteps.assertUnfundedHoldNothing(ctx)
    Assert.strictEqual(await SyndicationScenario.readBalance(ctx, Plan.user.account), 0n,
      "the delayed syndication released before recovery")
  }

  /**
   * Capture acceptance while the exact old digest is still independently visible on Solana.
   * @param ctx - The live cluster after request issuance.
   */
  export async function verifyOriginal(ctx: ClusterBuildContext): Promise<void> {
    const { Plan } = Constants,
      original = await SyndicationScenario.readEnvelope(ctx, Plan.firstEpoch),
      log = await readOutboundLog(ctx),
      record = log.envelopes.find(entry => entry.epochIndex === original.epoch_index)
    Assert.ok(record, "the original digest was already absent before the outage observation")
    Assert.ok(Checksum256.from(record.checksum).equals(original.digest),
      "original Solana digest differs from the accepted syndication")
    Assert.strictEqual(String(original.request_id), String(ctx.outputs.assert(Plan.firstRequest)))
    ctx.outputs.set(OriginalEnvelope, original)
    await assertStillUnbonded(ctx)
    StepExtraRecorder.note("original source digest and unbonded request", {
      epoch: original.epoch_index, digest: original.digest, requestId: original.request_id
    })
  }

  /**
   * Whether ten newer source records have replaced the old one and authenticate the tip.
   * @param log - The finalized source audit account.
   * @param original - The immutable accepted request's envelope.
   * @param checkpoint - The depot's accepted Solana tip.
   * @returns True only when direct historical lookup is impossible and a newer proof exists.
   */
  export function hasPrunedCheckpoint(
    log: EnvelopeLog,
    original: SysioContracts.SysioSyndEnvelopeRowType,
    checkpoint: SysioContracts.SysioMsgchOutpostConsensusEntryType
  ): boolean {
    const { envelopes } = log,
      retained = UnderwritingSteps.SolanaRetainedEnvelopeEpochs
    Assert.ok(envelopes.length <= retained, "the source audit window grew beyond ten records")
    envelopes.forEach((entry, index) => {
      Checksum256.from(entry.checksum)
      if (index > 0) Assert.ok(entry.epochIndex > envelopes[index - 1].epochIndex,
        "source epochs must be strictly increasing")
    })
    if (envelopes.length !== retained ||
      envelopes.some(entry => entry.epochIndex <= original.epoch_index) ||
      envelopes.at(-1).epochIndex < original.epoch_index + retained) return false
    if (!checkpoint || !checkpoint.consensus_reached ||
      BigInt(checkpoint.chain_code) !== BigInt(SlugName.from(SyndicationScenario.Chain)) ||
      checkpoint.epoch_index <= original.epoch_index) return false
    return envelopes.some(entry => entry.epochIndex === checkpoint.epoch_index &&
      Checksum256.from(entry.checksum).equals(checkpoint.envelope_digest))
  }

  /**
   * Wait for actual account pruning while continuously refusing premature coverage. Pruning needs
   * ten newer Solana envelopes and nothing is queued to Solana, so the wait keeps Solana due with
   * keep-due traffic (`EpochAdvanceSteps.pollForKeepingDue`): every advance it drives ships one.
   * @param ctx - The cluster with its sole funded node offline.
   * @param signal - Abort signal.
   */
  export async function verifyPruned(ctx: ClusterBuildContext, signal: AbortSignal): Promise<void> {
    const checkpoint = await Steps.epochAdvance.pollForKeepingDue(ctx, [SyndicationScenario.Chain],
      "old source digest pruned; newer accepted checkpoint authenticated",
      () => readPrunedCheckpoint(ctx),
      Constants.pruningBudgetMs(ctx.config.outpostEpochDurationSec[SyndicationScenario.Chain]), Constants.PruningPollMs,
      signal)
    ctx.outputs.set(PrunedCheckpoint, checkpoint)
    await assertStillUnbonded(ctx)
  }

  /**
   * Observe one pruning candidate, retrying read failures while keeping proof assertions fatal.
   * @param ctx - The cluster whose funded provider remains offline.
   * @returns The authenticated checkpoint, or nothing while history or RPC reads are unavailable.
   */
  export async function readPrunedCheckpoint(
    ctx: ClusterBuildContext
  ): Promise<SysioContracts.SysioMsgchOutpostConsensusEntryType> {
    const original = ctx.outputs.assert(OriginalEnvelope)
    let sourceLog: EnvelopeLog,
      checkpoint: SysioContracts.SysioMsgchOutpostConsensusEntryType
    try {
      await assertStillUnbonded(ctx)
      sourceLog = await readOutboundLog(ctx)
      const { rows, more } = await ctx.wire.getSysioContract(SysioContracts.SysioContractName.msgch)
        .tables.outpcons.query({ limit: SyndicationScenario.QueryLimit })
      Assert.ok(!more, "checkpoint query was truncated")
      checkpoint = rows.find(row => BigInt(row.chain_code) === BigInt(SlugName.from(SyndicationScenario.Chain)))
    } catch (error) {
      if (error instanceof Assert.AssertionError) throw error
      log.warn("Pruning observation read failed; retrying while the funded provider remains offline", error)
      return null
    }
    if (!hasPrunedCheckpoint(sourceLog, original, checkpoint)) return null
    ctx.outputs.set(PrunedSourceLog, sourceLog)
    return checkpoint
  }

  /**
   * Record the exact pruning proof in a short step, beyond the long poll's capped RPC capture.
   * @param ctx - The captured source account and checkpoint, before any restart.
   */
  export async function verifyPruningEvidence(ctx: ClusterBuildContext): Promise<void> {
    const original = ctx.outputs.assert(OriginalEnvelope),
      checkpoint = ctx.outputs.assert(PrunedCheckpoint),
      log = ctx.outputs.assert(PrunedSourceLog)
    Assert.ok(hasPrunedCheckpoint(log, original, checkpoint), "captured pruning proof does not authenticate the old request")
    await assertStillUnbonded(ctx)
    StepExtraRecorder.note("source history pruned before underwriter restart", {
      originalEpoch: original.epoch_index, requestId: original.request_id,
      originalDigest: original.digest, retainedEpochs: log.envelopes.map(entry => entry.epochIndex),
      checkpointEpoch: checkpoint.epoch_index, checkpointDigest: checkpoint.envelope_digest
    })
  }

  /**
   * Verify exact recipient credit, collected fee and returned provider capital.
   * @param ctx - The cluster after plugin approval and claim.
   */
  export async function verifySettled(ctx: ClusterBuildContext): Promise<void> {
    const { Plan } = Constants,
      before = ctx.outputs.assert(Plan.before),
      fee = SyndicationScenario.feeOf(Plan.amount, Plan.feeBps)
    Assert.ok(ctx.processManager.get(fundedNode(ctx).name), "the original node did not restart")
    Assert.ok(ctx.outputs.assert(PrunedCheckpoint).epoch_index > ctx.outputs.assert(Plan.firstEpoch))
    await pollUntil("exact delayed syndication settlement and returned underwriter capital", async () =>
      await SyndicationScenario.readBalance(ctx, Plan.user.account) === Plan.amount - fee &&
      await SyndicationScenario.readFees(ctx) === before.fees + fee &&
      await UnderwritingSteps.readOperatorsBalance(ctx) === before.operators &&
      await SyndicationScenario.readBalance(ctx, SysioContracts.SysioContractAccount.synd) === before.holder + fee,
    UnderwritingSteps.DaemonEffectBudgetMs, SyndicationScenario.PollMs)
    await UnderwritingSteps.assertUnfundedHoldNothing(ctx)
  }
}
