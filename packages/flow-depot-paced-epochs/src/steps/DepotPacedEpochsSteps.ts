import Assert from "node:assert"

import { SysioContracts } from "@wireio/sdk-core"
import { getLogger } from "@wireio/shared"

import {
  describeOutpostChains,
  mapOutpostChains,
  OutpostChainCodename,
  OutpostChainCodenames,
  type ClusterConfig,
  type OutpostEpochDurations,
  type PerOutpostChain
} from "@wireio/cluster-tool-shared"
import {
  ClusterBuildStep,
  EthereumFundingTool,
  EthereumRoundTripScenario,
  EthereumSyndicationTool,
  ManagedProcess,
  ProtocolTiming,
  SolanaOutpostBootstrapper,
  SolanaOutpostProgramTool,
  SolanaOutpostTarget,
  Steps,
  WireClient,
  WireEconomicClockTool,
  WireSyndicationTool,
  isCode,
  matchesProtoEnum,
  outputKey,
  pollFor,
  type ClusterBuildContext,
  type ClusterBuildStepOptions,
  type OutputKey,
  type Report,
  type StepInput
} from "@wireio/cluster-tool"

import { DepotPacedEpochsScenarioConstants as Constants } from "../DepotPacedEpochsScenarioConstants.js"

const log = getLogger(__filename)

const { SysioContractName, SysioMsgchChainkind, SysioSyndItemKind } = SysioContracts

/**
 * The depot-paced-epochs scenario's Steps: the waits and checks that show each pacing rule once.
 * An idle chain stays in its decided epoch; traffic — an outpost backlog its relays report, or a
 * message the depot queues — makes the chain due at the later of its epoch start plus its minimum
 * and its traffic plus its traffic wait, and it advances then; a strict majority of the seats on
 * duty decides an epoch at the delivery that completes it; and a member that missed its epoch
 * delivers it late, inside the late window, and is credited when the books close. Waits on
 * traffic the flow creates poll without the keep-due pump; only the late-delivery phase, which
 * needs advances nothing queued would bring, keeps Ethereum due. Every pure check is exported on
 * its own so the unit tests drive it without a chain.
 */
export namespace DepotPacedEpochsSteps {
  /** Every OPP stream position the idle check compares, at one instant. */
  export interface OppStreamSnapshot {
    /**
     * Each chain's newest depot → outpost envelope epoch retained in `sysio.msgch::outenvelopes`;
     * 0 while none is retained.
     */
    readonly outboundEpoch: PerOutpostChain<number>
    /**
     * Each outpost's own inbound cursor: the next depot epoch it accepts (Ethereum
     * `OPPInbound.nextEpochIndex`, Solana `OutpostConfig.next_epoch_index`).
     */
    readonly outpostCursor: PerOutpostChain<number>
  }

  /** A chain's consensus epoch as observed once its traffic was recorded. */
  export interface DueObservation {
    /** The chain's consensus reading with its traffic recorded. */
    readonly reading: WireEconomicClockTool.ConsensusReading
    /** The depot head of that reading (ms): at most one poll after the traffic was recorded. */
    readonly observedAtMs: number
    /** The group on duty in that epoch: the seats whose backlog reports count. */
    readonly group: readonly string[]
  }

  /** The Ethereum epoch the stopped member's group sits on duty for. */
  export interface DutyEpoch {
    /** The epoch's index. */
    readonly epochIndex: number
    /** The group on duty for it, the stopped member among them. */
    readonly group: readonly string[]
  }

  // ── Output keys ───────────────────────────────────────────────────────────

  /**
   * The `ctx.outputs` key an OPP stream snapshot is stored under, one per name.
   *
   * @param snapshotName - The snapshot's name within the scenario.
   * @returns The typed key.
   */
  export function streamSnapshotKey(snapshotName: string): OutputKey<OppStreamSnapshot> {
    return outputKey<OppStreamSnapshot>(
      `depotPacedEpochs.streams.${snapshotName}`,
      `every OPP stream position, recorded as "${snapshotName}"`
    )
  }

  /**
   * The `ctx.outputs` key a chain's due observation is stored under, one per chain.
   *
   * @param chain - The outpost chain.
   * @returns The typed key.
   */
  export function dueObservationKey(chain: OutpostChainCodename): OutputKey<DueObservation> {
    return outputKey<DueObservation>(
      `depotPacedEpochs.due.${chain}`,
      `the ${chain} consensus epoch once its traffic was recorded`
    )
  }

  /** The Ethereum epoch the stopped member's group sits on duty for. */
  export const DutyEpochKey = outputKey<DutyEpoch>(
    "depotPacedEpochs.dutyEpoch",
    "the Ethereum epoch the stopped member's group is on duty for"
  )

  /** The checksum of that epoch's accepted envelope. */
  export const WinningChecksumKey = outputKey<string>(
    "depotPacedEpochs.winningChecksum",
    "the checksum of the duty epoch's accepted envelope"
  )

  /** When the epoch after the duty epoch opened (ms): the start of the duty epoch's late window. */
  export const LateWindowStartKey = outputKey<number>(
    "depotPacedEpochs.lateWindowStart",
    "the start of the epoch after the duty epoch, which opens its late window"
  )

  // ── Pure rules ────────────────────────────────────────────────────────────

  /**
   * The strict majority of a group's seats — pure: more than half, `floor(seats / 2) + 1`.
   *
   * @param seats - The group's seats.
   * @returns The seats a decision or a backlog report needs.
   */
  export function strictMajorityOf(seats: number): number {
    return Math.floor(seats / 2) + 1
  }

  /**
   * The economic epochs the idle window awaits — pure: enough that their observation spans at
   * least `IdleWindowMinimums` of the longest chain minimum whatever point of an economic epoch it
   * starts at (`n` epochs opened span more than `n - 1` economic durations).
   *
   * @param config - The resolved cluster config.
   * @returns The economic epochs to await.
   */
  export function idleEconomicEpochs(config: ClusterConfig): number {
    const windowSec =
      Constants.IdleWindowMinimums * ProtocolTiming.slowestOutpostEpochSec(config.outpostEpochDurationSec)
    return Math.ceil(windowSec / config.economicEpochDurationSec) + 1
  }

  /**
   * How late after a chain is due its advance may open (ms) — pure: one relay poll of the chain
   * (`RelayPollsPerMinimum` per minimum, at least `RelayMinimumPollMs`), the tick it waits for,
   * and `AdvanceLandingBlocks` for the `chkcons` to land.
   *
   * @param minimumSec - The chain's minimum (s).
   * @returns The slack (ms).
   */
  export function advanceSlackMs(minimumSec: number): number {
    const pollMs = Math.max(
      (minimumSec * ProtocolTiming.MsPerSecond) / Constants.RelayPollsPerMinimum,
      Constants.RelayMinimumPollMs
    )
    return pollMs + Constants.RelayTickStepMs + Constants.AdvanceLandingBlocks * ProtocolTiming.BlockIntervalMs
  }

  /**
   * Each chain's newest depot → outpost envelope epoch — pure over one `outenvelopes` read.
   *
   * @param rows - Every `sysio.msgch::outenvelopes` row.
   * @returns Each chain's highest envelope epoch, 0 for a chain with none retained.
   */
  export function newestOutboundEpochs(
    rows: readonly SysioContracts.SysioMsgchOutboundEnvelopeType[]
  ): PerOutpostChain<number> {
    return mapOutpostChains(chain =>
      rows
        .filter(row => Steps.contracts.sysio.epoch.isChainRow(row.chain_code, chain))
        .reduce((newest, row) => Math.max(newest, Number(row.epoch_index)), 0)
    )
  }

  /**
   * Assert an observation saw every chain idle — pure: at each reading every chain sits at the
   * index it started at, decided, unpaused and with no traffic; the observation spans at least
   * `IdleWindowMinimums` of the longest minimum; and the economic clock opened epochs meanwhile.
   *
   * @param observation - The economic-clock observation of the idle window.
   * @param durations - Each chain's minimum (s).
   * @returns The window's span on the depot head (ms).
   * @throws On the first chain that moved, had traffic, was undecided or paused, a window too
   *   short, or an economic clock that did not tick.
   */
  export function assertIdleObservation(
    observation: WireEconomicClockTool.Observation,
    durations: OutpostEpochDurations
  ): number {
    const readings = WireEconomicClockTool.readingsOf(observation),
      { start } = observation,
      end = WireEconomicClockTool.latestReading(observation)
    readings.forEach(reading =>
      OutpostChainCodenames.forEach(chain => {
        const consensus = reading.consensus[chain],
          at = new Date(reading.headBlockTimeMs).toISOString()
        Assert.strictEqual(
          consensus.epochIndex,
          start.consensus[chain].epochIndex,
          `the idle ${chain} chain moved from epoch ${start.consensus[chain].epochIndex} to ` +
            `${consensus.epochIndex} by ${at}`
        )
        Assert.ok(
          WireEconomicClockTool.isIdleReading(consensus),
          `the ${chain} chain had traffic at ${at}: due at ${new Date(consensus.dueAtMs).toISOString()}`
        )
        Assert.ok(consensus.decided, `the ${chain} epoch ${consensus.epochIndex} was undecided at ${at}`)
        Assert.ok(!consensus.paused, `the ${chain} chain was paused at ${at}`)
      })
    )
    const spanMs = end.headBlockTimeMs - start.headBlockTimeMs,
      floorMs =
        Constants.IdleWindowMinimums * ProtocolTiming.slowestOutpostEpochSec(durations) * ProtocolTiming.MsPerSecond
    Assert.ok(spanMs >= floorMs, `the idle window spans ${spanMs} ms, under ${floorMs} ms`)
    Assert.ok(
      end.economicEpochIndex > start.economicEpochIndex,
      `the economic clock stayed at epoch ${start.economicEpochIndex} through the idle window`
    )
    return spanMs
  }

  /**
   * Assert no OPP stream moved between two snapshots — pure: no chain gained a depot → outpost
   * envelope and no outpost's inbound cursor moved.
   *
   * @param before - The snapshot as the window opened.
   * @param after - The snapshot as it closed.
   * @throws On the first chain whose envelope or cursor moved.
   */
  export function assertStreamsUnchanged(before: OppStreamSnapshot, after: OppStreamSnapshot): void {
    OutpostChainCodenames.forEach(chain => {
      Assert.strictEqual(
        after.outboundEpoch[chain],
        before.outboundEpoch[chain],
        `the depot built a ${chain} envelope for epoch ${after.outboundEpoch[chain]} while the chain was idle`
      )
      Assert.strictEqual(
        after.outpostCursor[chain],
        before.outpostCursor[chain],
        `the ${chain} outpost's inbound cursor moved from ${before.outpostCursor[chain]} to ` +
          `${after.outpostCursor[chain]} while the chain was idle`
      )
    })
  }

  /**
   * Assert a strict majority of the seats on duty reported the outpost's backlog in the epoch
   * the traffic made due, and that the chain's traffic dates from the oldest pending message the
   * majority's report holds — pure: `traffic_since` is the m-th smallest reported
   * `oldest_pending_at`, m the strict majority of the seats.
   *
   * @param reports - Every `sysio.msgch::qreports` row.
   * @param due - The chain's due observation.
   * @param chain - The outpost chain.
   * @throws When fewer than a strict majority of the seats reported, or the traffic dates from
   *   another time.
   */
  export function assertBacklogMajority(
    reports: readonly SysioContracts.SysioMsgchQueueReportEntryType[],
    due: DueObservation,
    chain: OutpostChainCodename
  ): void {
    const { reading, group } = due,
      majority = strictMajorityOf(group.length),
      oldest = reports
        .filter(
          report =>
            Steps.contracts.sysio.epoch.isChainRow(report.chain_code, chain) &&
            report.epoch_index === reading.epochIndex &&
            group.includes(report.account) &&
            report.pending_count > 0
        )
        .map(report => WireClient.chainTimeMs(report.oldest_pending_at))
        .sort((left, right) => left - right)
    Assert.ok(
      oldest.length >= majority,
      `${oldest.length} of the ${group.length} seats on duty reported the ${chain} backlog in epoch ` +
        `${reading.epochIndex}, under the ${majority} a strict majority needs`
    )
    Assert.strictEqual(
      reading.trafficSinceMs,
      oldest[majority - 1],
      `the ${chain} traffic dates from ${new Date(reading.trafficSinceMs).toISOString()}, ` +
        "not the oldest pending message the majority reported"
    )
  }

  /**
   * Assert a chain advanced once, and on time — pure: the reading after is the next epoch, it
   * opened no sooner than the chain's `due_at` and no later than the slack ({@link advanceSlackMs})
   * after the later of `due_at` and when the traffic was observed (traffic recorded past its due
   * time makes the chain due at once).
   *
   * @param due - The chain's due observation.
   * @param after - The chain's reading once it advanced.
   * @param minimumSec - The chain's minimum (s).
   * @param chain - The outpost chain.
   * @throws When the chain skipped an epoch, opened before it was due, or opened late.
   */
  export function assertTimelyAdvance(
    due: DueObservation,
    after: WireEconomicClockTool.ConsensusReading,
    minimumSec: number,
    chain: OutpostChainCodename
  ): void {
    const { dueAtMs, epochIndex } = due.reading,
      latestMs = Math.max(dueAtMs, due.observedAtMs) + advanceSlackMs(minimumSec)
    Assert.strictEqual(
      after.epochIndex,
      epochIndex + 1,
      `the ${chain} chain moved from epoch ${epochIndex} to ${after.epochIndex}, not once`
    )
    Assert.ok(
      after.epochStartMs >= dueAtMs,
      `the ${chain} epoch ${after.epochIndex} opened at ${new Date(after.epochStartMs).toISOString()}, ` +
        `before it was due at ${new Date(dueAtMs).toISOString()}`
    )
    Assert.ok(
      after.epochStartMs <= latestMs,
      `the ${chain} epoch ${after.epochIndex} opened at ${new Date(after.epochStartMs).toISOString()}, ` +
        `after ${new Date(latestMs).toISOString()}`
    )
  }

  /**
   * Assert every chain but `chain` still sits at its index of a snapshot — pure.
   *
   * @param before - Every chain's index at the snapshot.
   * @param readings - Every chain's consensus reading now.
   * @param chain - The chain the traffic was for.
   * @throws On the first other chain that moved.
   */
  export function assertOtherChainsHeld(
    before: Readonly<PerOutpostChain<number>>,
    readings: WireEconomicClockTool.ConsensusReadings,
    chain: OutpostChainCodename
  ): void {
    OutpostChainCodenames.filter(other => other !== chain).forEach(other =>
      Assert.strictEqual(
        readings[other].epochIndex,
        before[other],
        `the ${other} chain moved from epoch ${before[other]} to ${readings[other].epochIndex} on ${chain} traffic`
      )
    )
  }

  /**
   * Assert the burst's syndications share one depot inbound epoch, the one the traffic made due
   * — pure: `count` syndication items of the holder in that epoch, and the chain advanced once.
   *
   * @param items - The `sysio.synd::items` rows of the pair in the epoch after the due one.
   * @param pubkey - The holder's compressed public key, as the items carry it.
   * @param count - The syndications in the burst.
   * @param due - The chain's due observation.
   * @param reading - The chain's reading now.
   * @throws When the chain moved more than once or a syndication landed in another epoch.
   */
  export function assertBurstInOneEpoch(
    items: readonly SysioContracts.SysioSyndItemRowType[],
    pubkey: string,
    count: number,
    due: DueObservation,
    reading: WireEconomicClockTool.ConsensusReading
  ): void {
    const epochIndex = due.reading.epochIndex + 1,
      held = items.filter(
        item =>
          item.pubkey === pubkey &&
          item.epoch_index === epochIndex &&
          matchesProtoEnum(item.kind, SysioSyndItemKind, SysioSyndItemKind.SYNDICATION)
      )
    Assert.strictEqual(
      reading.epochIndex,
      epochIndex,
      `the chain moved from epoch ${due.reading.epochIndex} to ${reading.epochIndex}, not once`
    )
    Assert.strictEqual(
      held.length,
      count,
      `${held.length} of the ${count} syndications landed in depot epoch ${epochIndex}`
    )
  }

  /**
   * The group on duty for the epoch after the current one — pure: window slot `k` serves epoch
   * `current_epoch_index + k - current_batch_op_group`, so the next epoch's group sits one slot
   * past the cursor.
   *
   * @param state - The chain's `epochstate` row.
   * @returns The next epoch's group (absent when the window holds no such slot).
   */
  export function nextOnDutyGroup(state: SysioContracts.SysioEpochEpochStateType): string[] {
    return state?.batch_op_groups?.[state.current_batch_op_group + 1]
  }

  /**
   * The epoch `account` is next on duty for, when its relay can be stopped before that epoch opens
   * — pure: the chain's current epoch is decided, the next epoch's group seats `account`, and the
   * chain is idle or due no sooner than one graceful stop (`ManagedProcess.GracefulKillMs`) from the
   * head. The keep-due pump gives each new epoch traffic, so a decided epoch is usually already
   * waiting for its `due_at` and is never idle at that moment.
   *
   * @param state - The chain's `epochstate` row.
   * @param consensus - The chain's `outpcons` row.
   * @param account - The member's account.
   * @param headMs - The depot head (ms).
   * @returns The duty epoch and its group, or `undefined` while the member is not next or the
   *   advance is too close.
   */
  export function nextDutyEpochOf(
    state: SysioContracts.SysioEpochEpochStateType,
    consensus: SysioContracts.SysioMsgchOutpostConsensusEntryType,
    account: string,
    headMs: number
  ): DutyEpoch {
    const group = nextOnDutyGroup(state),
      ready =
        state != null &&
        Steps.epochAdvance.hasDecidedEpoch(consensus, state.current_epoch_index) &&
        group?.includes(account) &&
        Steps.contracts.sysio.epoch.msUntilDue(state, headMs) >= ManagedProcess.GracefulKillMs
    return ready ? { epochIndex: state.current_epoch_index + 1, group } : undefined
  }

  /**
   * Assert a strict majority decided the duty epoch at the delivery that completed it — pure:
   * the epoch's bucket holds exactly the strict majority of its seats, none from the stopped
   * member, every one the winner's bytes, and the depot accepted the envelope (its inbound
   * `envlog` row) in the same block as the last of them.
   *
   * @param bucket - The epoch's `sysio.msgch::envelopes` rows.
   * @param envelopeLog - Every `sysio.msgch::envlog` row.
   * @param duty - The duty epoch and its group.
   * @param absent - The stopped member's account.
   * @param winningChecksum - The accepted envelope's checksum.
   * @param chain - The outpost chain.
   * @throws When the bucket is not the majority, holds the stopped member or another envelope, or
   *   the acceptance did not land with its last delivery.
   */
  export function assertMajorityDecision(
    bucket: readonly SysioContracts.SysioMsgchEnvelopeEntryType[],
    envelopeLog: readonly SysioContracts.SysioMsgchEnvelopeLogEntryType[],
    duty: DutyEpoch,
    absent: string,
    winningChecksum: string,
    chain: OutpostChainCodename
  ): void {
    const majority = strictMajorityOf(duty.group.length),
      accepted = envelopeLog.filter(
        row =>
          Steps.contracts.sysio.epoch.isChainRow(row.chain_code, chain) &&
          row.epoch_index === duty.epochIndex &&
          matchesProtoEnum(row.endpoints.end.kind, SysioMsgchChainkind, SysioMsgchChainkind.CHAIN_KIND_WIRE)
      ),
      lastDeliveryMs = Math.max(...bucket.map(row => WireClient.chainTimeMs(row.received_at)))
    Assert.strictEqual(
      bucket.length,
      majority,
      `the ${chain} epoch ${duty.epochIndex} holds ${bucket.length} deliveries, not the ${majority} of ` +
        `${duty.group.length} seats a strict majority needs`
    )
    Assert.ok(
      !bucket.some(row => row.batch_op_name === absent),
      `the stopped ${absent} delivered the ${chain} epoch ${duty.epochIndex}`
    )
    Assert.ok(
      bucket.every(row => row.checksum === winningChecksum),
      `a delivery of the ${chain} epoch ${duty.epochIndex} differs from its accepted envelope`
    )
    Assert.strictEqual(
      accepted.length,
      1,
      `the ${chain} epoch ${duty.epochIndex} has ${accepted.length} inbound envlog rows`
    )
    Assert.strictEqual(
      WireClient.chainTimeMs(accepted[0].emitted_at),
      lastDeliveryMs,
      `the ${chain} epoch ${duty.epochIndex} was accepted at ${accepted[0].emitted_at}, ` +
        `not with its last delivery at ${new Date(lastDeliveryMs).toISOString()}`
    )
  }

  /**
   * Assert a late delivery was taken inside the late window — pure: the member's row repeats the
   * accepted envelope and arrived after the next epoch opened and before its late window closed.
   *
   * @param row - The member's `sysio.msgch::envelopes` row of the duty epoch.
   * @param winningChecksum - The accepted envelope's checksum.
   * @param windowStartMs - When the next epoch opened (ms).
   * @param lateWindowSec - The chain's `epochcfg.late_window_sec`.
   * @param chain - The outpost chain.
   * @throws When the row differs from the winner or arrived outside the late window.
   */
  export function assertLateDelivery(
    row: SysioContracts.SysioMsgchEnvelopeEntryType,
    winningChecksum: string,
    windowStartMs: number,
    lateWindowSec: number,
    chain: OutpostChainCodename
  ): void {
    const receivedMs = WireClient.chainTimeMs(row.received_at),
      windowEndMs = windowStartMs + lateWindowSec * ProtocolTiming.MsPerSecond
    Assert.strictEqual(
      row.checksum,
      winningChecksum,
      `${row.batch_op_name}'s late ${chain} delivery differs from the accepted envelope`
    )
    Assert.ok(
      receivedMs >= windowStartMs,
      `${row.batch_op_name}'s ${chain} delivery arrived at ${row.received_at}, ` +
        "before the next epoch opened: it was not late"
    )
    Assert.ok(
      receivedMs < windowEndMs,
      `${row.batch_op_name}'s late ${chain} delivery arrived at ${row.received_at}, ` +
        `after the late window closed at ${new Date(windowEndMs).toISOString()}`
    )
  }

  /**
   * The member's `sysio.opreg::dellog` rows of one chain's epoch — pure.
   *
   * @param rows - Every `dellog` row.
   * @param account - The member's account.
   * @param chain - The outpost chain.
   * @param epochIndex - The epoch.
   * @returns The member's rows of that epoch.
   */
  export function memberDeliveryRows(
    rows: readonly SysioContracts.SysioOpregDeliveryLogEntryType[],
    account: string,
    chain: OutpostChainCodename,
    epochIndex: number
  ): SysioContracts.SysioOpregDeliveryLogEntryType[] {
    return rows.filter(row => row.account === account && isCode(row.chain_code, chain) && row.epoch === epochIndex)
  }

  /**
   * Assert the books of an epoch credit the member's delivery — pure: exactly one `dellog` row of
   * it, delivered, so no miss.
   *
   * @param rows - The member's rows of the epoch ({@link memberDeliveryRows}).
   * @param account - The member's account.
   * @param epochIndex - The epoch.
   * @throws When the member has no row, several, or a miss.
   */
  export function assertDeliveryCredited(
    rows: readonly SysioContracts.SysioOpregDeliveryLogEntryType[],
    account: string,
    epochIndex: number
  ): void {
    Assert.strictEqual(rows.length, 1, `${account} has ${rows.length} dellog rows of epoch ${epochIndex}`)
    Assert.ok(rows[0].delivered, `the books of epoch ${epochIndex} record ${account}'s delivery as a miss`)
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  /**
   * READ every `sysio.msgch::outenvelopes` row: the depot → outpost envelopes the depot retains.
   *
   * @param ctx - The build context.
   * @returns The rows.
   * @throws When the read is truncated.
   */
  export async function readOutboundEnvelopes<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<SysioContracts.SysioMsgchOutboundEnvelopeType[]> {
    const { rows, more } = await ctx.wire
      .getSysioContract(SysioContractName.msgch)
      .tables.outenvelopes.query({ limit: Constants.OutboundEnvelopeRowLimit })
    Assert.ok(
      !more,
      `sysio.msgch::outenvelopes has more than ${Constants.OutboundEnvelopeRowLimit} rows; the read is truncated`
    )
    return rows
  }

  /** The `OutpostConfig` field the Solana cursor read consumes, as the Anchor coder decodes it. */
  interface OutpostConfigAccount {
    nextEpochIndex: number
  }

  /** Name of the Solana `OutpostConfig` account as the camelCased Anchor coder keys it. */
  export const OutpostConfigAccountName = "outpostConfig"

  /**
   * READ the Solana outpost's inbound cursor: `OutpostConfig.next_epoch_index`, the next depot
   * epoch it accepts.
   *
   * @param ctx - The build context.
   * @returns The cursor.
   * @throws When the outpost's `OutpostConfig` does not exist.
   */
  export async function readSolanaInboundCursor<C extends ClusterBuildContext>(ctx: C): Promise<number> {
    const target = SolanaOutpostTarget.resolve(ctx),
      address = SolanaOutpostProgramTool.derivePda(
        target.programId,
        Buffer.from(SolanaOutpostBootstrapper.PdaSeed.OutpostConfig)
      ),
      account = await target.connection.getAccountInfo(address)
    Assert.ok(account != null, `the Solana OutpostConfig ${address.toBase58()} does not exist`)
    return SolanaOutpostProgramTool.loadReadOnlyProgram(
      target.connection,
      target.solanaPath,
      SolanaOutpostProgramTool.ProgramName,
      target.programId
    ).coder.accounts.decode<OutpostConfigAccount>(OutpostConfigAccountName, account.data).nextEpochIndex
  }

  /**
   * READ every OPP stream position the idle check compares: the depot's newest envelope per chain
   * and each outpost's inbound cursor.
   *
   * @param ctx - The build context.
   * @returns The snapshot.
   */
  export async function readOppStreams<C extends ClusterBuildContext>(ctx: C): Promise<OppStreamSnapshot> {
    const [envelopes, ethereumCursor, solanaCursor] = await Promise.all([
      readOutboundEnvelopes(ctx),
      EthereumRoundTripScenario.readInboundEpoch(ctx),
      readSolanaInboundCursor(ctx)
    ])
    return {
      outboundEpoch: newestOutboundEpochs(envelopes),
      outpostCursor: {
        [OutpostChainCodename.ETHEREUM]: Number(ethereumCursor),
        [OutpostChainCodename.SOLANA]: solanaCursor
      }
    }
  }

  /**
   * READ every `sysio.msgch::qreports` row: each member's latest outpost backlog report per chain.
   *
   * @param ctx - The build context.
   * @returns The rows.
   */
  export async function readQueueReports<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<SysioContracts.SysioMsgchQueueReportEntryType[]> {
    return ctx.wire.getSysioContract(SysioContractName.msgch).tables.qreports.queryAll()
  }

  /**
   * READ every `sysio.msgch::envlog` row: the envelopes the depot accepted and emitted.
   *
   * @param ctx - The build context.
   * @returns The rows.
   */
  export async function readEnvelopeLog<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<SysioContracts.SysioMsgchEnvelopeLogEntryType[]> {
    return ctx.wire.getSysioContract(SysioContractName.msgch).tables.envlog.queryAll()
  }

  /**
   * READ every `sysio.opreg::dellog` row: each member's hit or miss per closed epoch.
   *
   * @param ctx - The build context.
   * @returns The rows.
   */
  export async function readDeliveryLog<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<SysioContracts.SysioOpregDeliveryLogEntryType[]> {
    return ctx.wire.getSysioContract(SysioContractName.opreg).tables.dellog.queryAll()
  }

  // ── Step: one chain decided and idle ──────────────────────────────────────

  /** Input of the steps that name one outpost chain. */
  export interface ChainInput extends StepInput {
    readonly kind: "DepotPacedEpochsSteps.ChainInput"
    /** The outpost chain. */
    readonly chain: OutpostChainCodename
  }

  /** The {@link ChainInput} of `chain`. */
  function createChainInput(chain: OutpostChainCodename): ChainInput {
    return { kind: "DepotPacedEpochsSteps.ChainInput", chain }
  }

  /**
   * Wait until `chain`'s current epoch is decided and the chain idle, adding no traffic
   * (`EpochAdvanceSteps.awaitDecidedAndIdle`). Pair it with
   * `ProtocolTiming.pollStepOptions(EpochAdvanceSteps.epochAdvanceBudgetMs(config, chain))`.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param chain - The outpost chain.
   * @returns The await step.
   */
  export function planAwaitDecidedAndIdle<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    chain: OutpostChainCodename
  ): ClusterBuildStep<C, ChainInput> {
    return ClusterBuildStep.create<C, ChainInput>(
      actor,
      name,
      description,
      options,
      createChainInput(chain),
      runAwaitDecidedAndIdle
    )
  }

  /**
   * Named runner — poll the chain until its current epoch is decided and it is idle.
   *
   * @param ctx - The build context.
   * @param input - The chain.
   * @param signal - Abort signal.
   * @throws When the chain is not decided and idle within its epoch-advance budget.
   */
  export async function runAwaitDecidedAndIdle<C extends ClusterBuildContext>(
    ctx: C,
    input: ChainInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await Steps.epochAdvance.awaitDecidedAndIdle(ctx, input.chain, Constants.PollIntervalMs)
  }

  // ── Steps: the idle window ────────────────────────────────────────────────

  /** Input for {@link planRecordOppStreams}. */
  export interface RecordOppStreamsInput extends StepInput {
    readonly kind: "DepotPacedEpochsSteps.RecordOppStreamsInput"
    /** The name the snapshot is stored under ({@link streamSnapshotKey}). */
    readonly snapshotName: string
  }

  /**
   * Record every OPP stream position now ({@link readOppStreams}) — a read, carried by a Step
   * because the idle check compares against it.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param snapshotName - The name the snapshot is stored under.
   * @returns The record step.
   */
  export function planRecordOppStreams<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    snapshotName: string
  ): ClusterBuildStep<C, RecordOppStreamsInput> {
    return ClusterBuildStep.create<C, RecordOppStreamsInput>(
      actor,
      name,
      description,
      options,
      { kind: "DepotPacedEpochsSteps.RecordOppStreamsInput", snapshotName },
      runRecordOppStreams
    )
  }

  /**
   * Named runner — read every stream position and store the snapshot.
   *
   * @param ctx - The build context.
   * @param input - The snapshot's name.
   * @param signal - Abort signal.
   */
  export async function runRecordOppStreams<C extends ClusterBuildContext>(
    ctx: C,
    input: RecordOppStreamsInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    ctx.outputs.set(streamSnapshotKey(input.snapshotName), await readOppStreams(ctx))
  }

  /** Input for {@link planVerifyIdle}. */
  export interface VerifyIdleInput extends StepInput {
    readonly kind: "DepotPacedEpochsSteps.VerifyIdleInput"
    /** The economic-clock observation of the window (`WireEconomicClockTool.observationKey`). */
    readonly observationName: string
    /** The stream snapshot taken as the window opened. */
    readonly fromSnapshotName: string
    /** The stream snapshot taken as it closed. */
    readonly toSnapshotName: string
  }

  /**
   * Assert every chain stayed idle through the window ({@link assertIdleObservation}) and no OPP
   * stream moved ({@link assertStreamsUnchanged}).
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param observationName - The economic-clock observation of the window.
   * @param fromSnapshotName - The stream snapshot taken as the window opened.
   * @param toSnapshotName - The stream snapshot taken as it closed.
   * @returns The verify step.
   */
  export function planVerifyIdle<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    observationName: string,
    fromSnapshotName: string,
    toSnapshotName: string
  ): ClusterBuildStep<C, VerifyIdleInput> {
    return ClusterBuildStep.create<C, VerifyIdleInput>(
      actor,
      name,
      description,
      options,
      { kind: "DepotPacedEpochsSteps.VerifyIdleInput", observationName, fromSnapshotName, toSnapshotName },
      runVerifyIdle
    )
  }

  /**
   * Named runner — read the observation and both snapshots back and assert them.
   *
   * @param ctx - The build context.
   * @param input - The observation and the snapshots.
   * @param signal - Abort signal.
   * @throws When a value was never recorded, or a check fails.
   */
  export async function runVerifyIdle<C extends ClusterBuildContext>(
    ctx: C,
    input: VerifyIdleInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const observation = ctx.outputs.assert(WireEconomicClockTool.observationKey(input.observationName)),
      spanMs = assertIdleObservation(observation, ctx.config.outpostEpochDurationSec)
    assertStreamsUnchanged(
      ctx.outputs.assert(streamSnapshotKey(input.fromSnapshotName)),
      ctx.outputs.assert(streamSnapshotKey(input.toSnapshotName))
    )
    log.info(
      `[depot-paced-epochs] idle for ${spanMs} ms at ${describeOutpostChains(
        observation.start.consensus,
        WireEconomicClockTool.describeConsensusReading
      )}`
    )
  }

  // ── Steps: traffic makes a chain due ──────────────────────────────────────

  /**
   * Wait for `chain` to have traffic, record when it is due, and assert its `due_at` is the later
   * of its epoch start plus its minimum and its traffic plus its traffic wait
   * (`WireEconomicClockTool.assertDueAt`). The traffic is the flow's own message, so the wait adds
   * none.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param chain - The outpost chain.
   * @returns The await step.
   */
  export function planAwaitChainDue<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    chain: OutpostChainCodename
  ): ClusterBuildStep<C, ChainInput> {
    return ClusterBuildStep.create<C, ChainInput>(
      actor,
      name,
      description,
      options,
      createChainInput(chain),
      runAwaitChainDue
    )
  }

  /**
   * Named runner — poll every chain's consensus until `chain` has traffic, then store and check it.
   *
   * @param ctx - The build context.
   * @param input - The chain.
   * @param signal - Abort signal.
   * @throws When the chain gets no traffic within `DueBudgetEpochs`, or its `due_at` is off the rule.
   */
  export async function runAwaitChainDue<C extends ClusterBuildContext>(
    ctx: C,
    input: ChainInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const { chain } = input,
      observed = await pollFor(
        `the ${chain} chain has traffic`,
        async () => {
          const [readings, info] = await Promise.all([
              WireEconomicClockTool.readConsensusReadings(ctx),
              ctx.wire.getInfo()
            ]),
            reading = readings[chain]
          return WireEconomicClockTool.isIdleReading(reading)
            ? null
            : { reading, observedAtMs: WireClient.chainTimeMs(info.head_block_time) }
        },
        ProtocolTiming.effectiveEpochsMs(ctx.config.outpostEpochDurationSec[chain], Constants.DueBudgetEpochs),
        Constants.PollIntervalMs
      ),
      [configs, group] = await Promise.all([
        Steps.contracts.sysio.epoch.readEpochConfigs(ctx),
        Steps.contracts.sysio.epoch.activeBatchOperatorGroup(ctx, chain)
      ])
    WireEconomicClockTool.assertDueAt(observed.reading, configs[chain], chain)
    ctx.outputs.set(dueObservationKey(chain), { ...observed, group })
    log.info(
      `[depot-paced-epochs] ${chain} epoch ${observed.reading.epochIndex} has traffic since ` +
        `${new Date(observed.reading.trafficSinceMs).toISOString()}, ` +
        `due at ${new Date(observed.reading.dueAtMs).toISOString()}`
    )
  }

  /**
   * Assert a strict majority of `chain`'s seats on duty reported its outpost backlog, and its
   * traffic dates from the oldest message they reported ({@link assertBacklogMajority}).
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param chain - The outpost chain.
   * @returns The verify step.
   */
  export function planVerifyBacklogReports<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    chain: OutpostChainCodename
  ): ClusterBuildStep<C, ChainInput> {
    return ClusterBuildStep.create<C, ChainInput>(
      actor,
      name,
      description,
      options,
      createChainInput(chain),
      runVerifyBacklogReports
    )
  }

  /**
   * Named runner — read the backlog reports and assert them against the due observation.
   *
   * @param ctx - The build context.
   * @param input - The chain.
   * @param signal - Abort signal.
   * @throws When the due observation was never recorded, or {@link assertBacklogMajority} fails.
   */
  export async function runVerifyBacklogReports<C extends ClusterBuildContext>(
    ctx: C,
    input: ChainInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    assertBacklogMajority(
      await readQueueReports(ctx),
      ctx.outputs.assert(dueObservationKey(input.chain)),
      input.chain
    )
  }

  /** Input for {@link planAwaitDueAdvance}. */
  export interface AwaitDueAdvanceInput extends StepInput {
    readonly kind: "DepotPacedEpochsSteps.AwaitDueAdvanceInput"
    /** The outpost chain the traffic was for. */
    readonly chain: OutpostChainCodename
    /** The epoch-index snapshot every other chain must still sit at (`EpochAdvanceSteps.epochIndicesKey`). */
    readonly beforeSnapshotName: string
  }

  /**
   * Wait for `chain` to advance on its traffic, adding none, and assert it advanced once and on
   * time ({@link assertTimelyAdvance}) while every other chain stayed at its snapshot index
   * ({@link assertOtherChainsHeld}).
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param chain - The outpost chain.
   * @param beforeSnapshotName - The epoch-index snapshot taken before the traffic.
   * @returns The await step.
   */
  export function planAwaitDueAdvance<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    chain: OutpostChainCodename,
    beforeSnapshotName: string
  ): ClusterBuildStep<C, AwaitDueAdvanceInput> {
    return ClusterBuildStep.create<C, AwaitDueAdvanceInput>(
      actor,
      name,
      description,
      options,
      { kind: "DepotPacedEpochsSteps.AwaitDueAdvanceInput", chain, beforeSnapshotName },
      runAwaitDueAdvance
    )
  }

  /**
   * Named runner — poll every chain's consensus until `chain` moved past its due epoch, then check.
   *
   * @param ctx - The build context.
   * @param input - The chain and the snapshot.
   * @param signal - Abort signal.
   * @throws When a value was never recorded, the chain does not advance in time, or a check fails.
   */
  export async function runAwaitDueAdvance<C extends ClusterBuildContext>(
    ctx: C,
    input: AwaitDueAdvanceInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const { chain } = input,
      due = ctx.outputs.assert(dueObservationKey(chain)),
      before = ctx.outputs.assert(Steps.epochAdvance.epochIndicesKey(input.beforeSnapshotName)),
      readings = await pollFor(
        `the ${chain} chain advances past epoch ${due.reading.epochIndex}`,
        async () => {
          const read = await WireEconomicClockTool.readConsensusReadings(ctx)
          return read[chain].epochIndex > due.reading.epochIndex ? read : null
        },
        ProtocolTiming.effectiveEpochsMs(ctx.config.outpostEpochDurationSec[chain], Constants.AdvanceBudgetEpochs),
        Constants.PollIntervalMs
      )
    assertTimelyAdvance(due, readings[chain], ctx.config.outpostEpochDurationSec[chain], chain)
    assertOtherChainsHeld(before, readings, chain)
    log.info(
      `[depot-paced-epochs] ${chain} epoch ${readings[chain].epochIndex} opened ` +
        `${readings[chain].epochStartMs - due.reading.dueAtMs} ms after it was due`
    )
  }

  /** Input for {@link planVerifyBurstInOneEpoch}. */
  export interface VerifyBurstInOneEpochInput extends StepInput {
    readonly kind: "DepotPacedEpochsSteps.VerifyBurstInOneEpochInput"
    /** Durable handle of the holder's persisted Ethereum wallet. */
    readonly walletName: string
    /** The syndications in the burst. */
    readonly count: number
  }

  /**
   * Assert the Ethereum burst's syndications all landed in the one depot inbound epoch the traffic
   * made due, and Ethereum advanced once for them ({@link assertBurstInOneEpoch}). Run it once
   * Ethereum is decided and idle again.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param walletName - Durable handle of the holder's persisted wallet.
   * @param count - The syndications in the burst.
   * @returns The verify step.
   */
  export function planVerifyBurstInOneEpoch<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    walletName: string,
    count: number
  ): ClusterBuildStep<C, VerifyBurstInOneEpochInput> {
    return ClusterBuildStep.create<C, VerifyBurstInOneEpochInput>(
      actor,
      name,
      description,
      options,
      { kind: "DepotPacedEpochsSteps.VerifyBurstInOneEpochInput", walletName, count },
      runVerifyBurstInOneEpoch
    )
  }

  /**
   * Named runner — read the pair's items of the epoch after the due one and Ethereum's consensus.
   *
   * @param ctx - The build context.
   * @param input - The holder and the burst size.
   * @param signal - Abort signal.
   * @throws When the due observation was never recorded, or {@link assertBurstInOneEpoch} fails.
   */
  export async function runVerifyBurstInOneEpoch<C extends ClusterBuildContext>(
    ctx: C,
    input: VerifyBurstInOneEpochInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const chain = OutpostChainCodename.ETHEREUM,
      due = ctx.outputs.assert(dueObservationKey(chain)),
      [items, readings] = await Promise.all([
        WireSyndicationTool.readItems(
          ctx,
          chain,
          EthereumSyndicationTool.LiqEthTokenCodename,
          due.reading.epochIndex + 1
        ),
        WireEconomicClockTool.readConsensusReadings(ctx)
      ])
    assertBurstInOneEpoch(
      items,
      EthereumFundingTool.compressedPubkey(ctx, input.walletName).slice(2),
      input.count,
      due,
      readings[chain]
    )
  }

  // ── Steps: a strict majority decides, a late delivery is credited ─────────

  /** Input of the steps that follow one member of a chain's group. */
  export interface MemberInput extends StepInput {
    readonly kind: "DepotPacedEpochsSteps.MemberInput"
    /** The outpost chain. */
    readonly chain: OutpostChainCodename
    /** The member's durable label. */
    readonly label: string
  }

  /** The {@link MemberInput} of `label` on `chain`. */
  function createMemberInput(chain: OutpostChainCodename, label: string): MemberInput {
    return { kind: "DepotPacedEpochsSteps.MemberInput", chain, label }
  }

  /**
   * Wait, keeping `chain` due, until its current epoch is decided, the member sits in the group on
   * duty for the next epoch and that epoch opens no sooner than one graceful stop from now
   * ({@link nextDutyEpochOf}), and record that epoch and its group ({@link DutyEpochKey}).
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param chain - The outpost chain.
   * @param label - The member's durable label.
   * @returns The await step.
   */
  export function planAwaitMemberNextOnDuty<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    chain: OutpostChainCodename,
    label: string
  ): ClusterBuildStep<C, MemberInput> {
    return ClusterBuildStep.create<C, MemberInput>(
      actor,
      name,
      description,
      options,
      createMemberInput(chain, label),
      runAwaitMemberNextOnDuty
    )
  }

  /**
   * Named runner — poll the chain's `epochstate`, `outpcons` and head, keeping it due, until the
   * member is next on duty with time to stop its relay.
   *
   * @param ctx - The build context.
   * @param input - The chain and the member.
   * @param signal - Abort signal.
   * @throws When the member does not come next on duty within `NextOnDutyBudgetEpochs`.
   */
  export async function runAwaitMemberNextOnDuty<C extends ClusterBuildContext>(
    ctx: C,
    input: MemberInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const { chain } = input,
      account = ctx.keyStore.assertOperator(input.label).account,
      duty = await Steps.epochAdvance.pollForKeepingDue(
        ctx,
        [chain],
        `${input.label} sits in the ${chain} group on duty next, the epoch decided and its advance a stop away`,
        async () => {
          const [states, consensus, info] = await Promise.all([
            Steps.contracts.sysio.epoch.readEpochStates(ctx),
            Steps.contracts.sysio.msgch.readOutpostConsensus(ctx),
            ctx.wire.getInfo()
          ])
          return nextDutyEpochOf(
            states[chain],
            consensus[chain],
            account,
            WireClient.chainTimeMs(info.head_block_time)
          )
        },
        ProtocolTiming.effectiveEpochsMs(ctx.config.outpostEpochDurationSec[chain], Constants.NextOnDutyBudgetEpochs),
        Constants.PollIntervalMs,
        signal
      )
    ctx.outputs.set(DutyEpochKey, duty)
    log.info(
      `[depot-paced-epochs] ${input.label} is on duty for ${chain} epoch ${duty.epochIndex} ` +
        `with ${duty.group.join(", ")}`
    )
  }

  /**
   * Wait, keeping `chain` due, for the duty epoch to be decided, and assert a strict majority of its
   * seats decided it at the delivery that completed it, the stopped member absent
   * ({@link assertMajorityDecision}); record its winner ({@link WinningChecksumKey}).
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param chain - The outpost chain.
   * @param label - The stopped member's durable label.
   * @returns The await step.
   */
  export function planAwaitMajorityDecision<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    chain: OutpostChainCodename,
    label: string
  ): ClusterBuildStep<C, MemberInput> {
    return ClusterBuildStep.create<C, MemberInput>(
      actor,
      name,
      description,
      options,
      createMemberInput(chain, label),
      runAwaitMajorityDecision
    )
  }

  /**
   * Named runner — poll `outpcons`, keeping the chain due, until it accepts the duty epoch's winner,
   * then read the epoch's deliveries and the envelope log and check them.
   *
   * @param ctx - The build context.
   * @param input - The chain and the stopped member.
   * @param signal - Abort signal.
   * @throws When the duty epoch was never recorded, it is not decided in time, or
   *   {@link assertMajorityDecision} fails.
   */
  export async function runAwaitMajorityDecision<C extends ClusterBuildContext>(
    ctx: C,
    input: MemberInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const { chain } = input,
      duty = ctx.outputs.assert(DutyEpochKey),
      consensus = await Steps.epochAdvance.pollForKeepingDue(
        ctx,
        [chain],
        `the ${chain} epoch ${duty.epochIndex} is decided`,
        async () => {
          const row = (await Steps.contracts.sysio.msgch.readOutpostConsensus(ctx))[chain]
          return Steps.epochAdvance.hasDecidedEpoch(row, duty.epochIndex) ? row : null
        },
        ProtocolTiming.effectiveEpochsMs(ctx.config.outpostEpochDurationSec[chain], Constants.MajorityBudgetEpochs),
        Constants.PollIntervalMs,
        signal
      )
    Assert.strictEqual(
      consensus.epoch_index,
      duty.epochIndex,
      `the ${chain} chain decided epoch ${consensus.epoch_index} past epoch ${duty.epochIndex}`
    )
    const [envelopes, envelopeLog] = await Promise.all([
      Steps.contracts.sysio.msgch.readEnvelopes(ctx),
      readEnvelopeLog(ctx)
    ])
    assertMajorityDecision(
      Steps.contracts.sysio.msgch.outpostEpochEnvelopes(envelopes, chain, duty.epochIndex),
      envelopeLog,
      duty,
      ctx.keyStore.assertOperator(input.label).account,
      consensus.winning_checksum,
      chain
    )
    ctx.outputs.set(WinningChecksumKey, consensus.winning_checksum)
  }

  /**
   * Wait, keeping `chain` due, for the epoch after the duty epoch to open, and record when it
   * opened: the start of the duty epoch's late window ({@link LateWindowStartKey}).
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param chain - The outpost chain.
   * @returns The await step.
   */
  export function planAwaitNextEpochOpened<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    chain: OutpostChainCodename
  ): ClusterBuildStep<C, ChainInput> {
    return ClusterBuildStep.create<C, ChainInput>(
      actor,
      name,
      description,
      options,
      createChainInput(chain),
      runAwaitNextEpochOpened
    )
  }

  /**
   * Named runner — poll the chain's consensus, keeping it due, until it moved past the duty epoch.
   *
   * @param ctx - The build context.
   * @param input - The chain.
   * @param signal - Abort signal.
   * @throws When the duty epoch was never recorded, the chain skipped an epoch, or it does not
   *   advance in time.
   */
  export async function runAwaitNextEpochOpened<C extends ClusterBuildContext>(
    ctx: C,
    input: ChainInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const { chain } = input,
      duty = ctx.outputs.assert(DutyEpochKey),
      reading = await Steps.epochAdvance.pollForKeepingDue(
        ctx,
        [chain],
        `the ${chain} chain advances past epoch ${duty.epochIndex}`,
        async () => {
          const read = (await WireEconomicClockTool.readConsensusReadings(ctx))[chain]
          return read.epochIndex > duty.epochIndex ? read : null
        },
        ProtocolTiming.effectiveEpochsMs(ctx.config.outpostEpochDurationSec[chain], Constants.NextEpochBudgetEpochs),
        Constants.PollIntervalMs,
        signal
      )
    Assert.strictEqual(
      reading.epochIndex,
      duty.epochIndex + 1,
      `the ${chain} chain moved from epoch ${duty.epochIndex} to ${reading.epochIndex}`
    )
    ctx.outputs.set(LateWindowStartKey, reading.epochStartMs)
  }

  /**
   * Wait for the member's late delivery of the duty epoch, adding no traffic, and assert it
   * repeats the accepted envelope and landed inside the late window ({@link assertLateDelivery}).
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param chain - The outpost chain.
   * @param label - The member's durable label.
   * @returns The await step.
   */
  export function planAwaitLateDelivery<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    chain: OutpostChainCodename,
    label: string
  ): ClusterBuildStep<C, MemberInput> {
    return ClusterBuildStep.create<C, MemberInput>(
      actor,
      name,
      description,
      options,
      createMemberInput(chain, label),
      runAwaitLateDelivery
    )
  }

  /**
   * Named runner — poll the depot's deliveries until the member's row of the duty epoch appears.
   *
   * @param ctx - The build context.
   * @param input - The chain and the member.
   * @param signal - Abort signal.
   * @throws When a value was never recorded, no late delivery lands in time, or
   *   {@link assertLateDelivery} fails.
   */
  export async function runAwaitLateDelivery<C extends ClusterBuildContext>(
    ctx: C,
    input: MemberInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const { chain } = input,
      duty = ctx.outputs.assert(DutyEpochKey),
      account = ctx.keyStore.assertOperator(input.label).account,
      row = await pollFor(
        `${input.label} delivers the ${chain} epoch ${duty.epochIndex} late`,
        async () =>
          Steps.contracts.sysio.msgch
            .outpostEpochEnvelopes(await Steps.contracts.sysio.msgch.readEnvelopes(ctx), chain, duty.epochIndex)
            .find(candidate => candidate.batch_op_name === account),
        ProtocolTiming.effectiveEpochsMs(ctx.config.outpostEpochDurationSec[chain], Constants.LateDeliveryBudgetEpochs),
        Constants.PollIntervalMs
      ),
      config = await Steps.contracts.sysio.epoch.readEpochConfig(ctx, chain)
    assertLateDelivery(
      row,
      ctx.outputs.assert(WinningChecksumKey),
      ctx.outputs.assert(LateWindowStartKey),
      config.late_window_sec,
      chain
    )
    log.info(
      `[depot-paced-epochs] ${input.label} delivered the ${chain} epoch ${duty.epochIndex} late at ${row.received_at}`
    )
  }

  /**
   * Wait, keeping `chain` due, for the advance that closes the duty epoch's books, and assert they
   * credit the member's delivery ({@link assertDeliveryCredited}).
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param chain - The outpost chain.
   * @param label - The member's durable label.
   * @returns The await step.
   */
  export function planAwaitDeliveryCredited<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    chain: OutpostChainCodename,
    label: string
  ): ClusterBuildStep<C, MemberInput> {
    return ClusterBuildStep.create<C, MemberInput>(
      actor,
      name,
      description,
      options,
      createMemberInput(chain, label),
      runAwaitDeliveryCredited
    )
  }

  /**
   * Named runner — poll `dellog`, keeping the chain due, until the member's row of the duty epoch
   * appears, then check it.
   *
   * @param ctx - The build context.
   * @param input - The chain and the member.
   * @param signal - Abort signal.
   * @throws When the duty epoch was never recorded, its books do not close in time, or
   *   {@link assertDeliveryCredited} fails.
   */
  export async function runAwaitDeliveryCredited<C extends ClusterBuildContext>(
    ctx: C,
    input: MemberInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const { chain } = input,
      duty = ctx.outputs.assert(DutyEpochKey),
      account = ctx.keyStore.assertOperator(input.label).account,
      rows = await Steps.epochAdvance.pollForKeepingDue(
        ctx,
        [chain],
        `the books of the ${chain} epoch ${duty.epochIndex} close`,
        async () => {
          const read = memberDeliveryRows(await readDeliveryLog(ctx), account, chain, duty.epochIndex)
          return read.length > 0 ? read : null
        },
        ProtocolTiming.effectiveEpochsMs(ctx.config.outpostEpochDurationSec[chain], Constants.BooksClosingBudgetEpochs),
        Constants.PollIntervalMs,
        signal
      )
    assertDeliveryCredited(rows, account, duty.epochIndex)
  }
}
