import "jest"
import { match, P } from "ts-pattern"
import {
  AttestationType,
  Envelope,
  OperatorStatus,
  NodeOwnerTier
} from "@wireio/opp-typescript-models"
import { SlugName } from "@wireio/sdk-core"
import {
  DEV_K1_PUBLIC_KEY,
  FlowTestContext,
  freshEthPubEm,
  log,
  pollUntil,
  ProcessManager,
  provisionFreshBatchOperator,
  pushNewNamedUser,
  pushNodeOwnerReg
} from "@wireio/test-cluster-tool"

/**
 * Flow: Batch Operator Slashing via the OPP envelope dispute vote.
 *
 * Exercises the full dispute-vote path end-to-end (the in-repo C++ suite
 * `contracts/tests/sysio.dispute_tests.cpp` covers the chalg actions in
 * isolation; this flow covers the trigger + slash economics against a live
 * cluster):
 *
 *   1. Three batch operators deliver THREE DISTINCT envelope versions for one
 *      (outpost, epoch) with no majority, past the epoch boundary.
 *      `sysio.msgch::evalcons` detects the 3-way split and inline-calls
 *      `sysio.chalg::opendispute`, which pauses the epoch.
 *   2. Tier-1 node owners vote (`sysio.chalg::votedispute`) for the canonical
 *      checksum.
 *   3. A permissionless crank (`sysio.chalg::chkdispute`) tallies the votes;
 *      once a checksum reaches floor(N/2)+1 of the live Tier-1 count it wins.
 *      chkdispute records the winner, dispatches the winning envelope via
 *      `sysio.msgch::resolvedisp`, and unpauses the epoch.
 *   4. On the next `advance`, every operator that delivered a NON-canonical
 *      checksum is slashed (`sysio.opreg::slash`, bond -> LP, status SLASHED).
 *      The operator that delivered the canonical checksum is NOT slashed.
 *
 * Plus the routine (non-dispute) paths:
 *   - 2-version split with a clear majority -> the minority op is SLASHED
 *     directly in `advance` (no vote).
 *   - An operator that delivers NOTHING is never slashed -- it stays on the
 *     existing miss -> recorddel -> termcheck -> terminate ladder.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * STATUS: scaffold. The cluster bootstrap, Tier-1 voter provisioning, dispute
 * voting, and the assertions use confirmed `@wireio/test-cluster-tool` APIs.
 * The one piece that needs to be finalized against a live cluster is the
 * DIVERGENT DELIVERY INJECTION (see `injectDivergentDeliveries` below): the
 * real SBPs deliver consistent envelopes, so to force a 3-way split the three
 * target operators must be the sole deliverers for the target (outpost, epoch)
 * and their deliveries must be pushed with three distinct envelope payloads.
 * The exact envelope encoding helper (`@wireio/opp-typescript-models` Envelope)
 * and SBP-suppression wiring are marked with TODO(live) below.
 * ──────────────────────────────────────────────────────────────────────────
 */

// ──────────────────────────────────────────────────────────────────────
//  Config
// ──────────────────────────────────────────────────────────────────────

const TEST_EPOCH_DURATION_SEC = 60
const MsPerSecond = 1_000
const PollDeadlineBufferMs = 30_000
const LongPollIntervalMs   = 3_000
// Bootstrap (~5 min) PLUS provisioning 3 SBP-less dispute ops (ETH/SOL identities each) and waiting for
// them to flip ACTIVE + become the sole active group across a few epochs.
const BootstrapTimeoutMs   = 1_200_000
/** HD slots for the 3 dispute ops' ETH wallets — past every bootstrapped operator slot. */
const DISPUTE_OP_HD_BASE   = 35

/** Tier-1 node owners provisioned as the dispute electorate. Names MUST be 2-6 chars — sysio.roa
 *  `valid_name_for_tier` rejects longer Tier-1 names (NAME_INVALID, a soft-fail that never registers
 *  and never bumps nodecount.t1_count). The bootstrap node owner `wireno` is ALSO Tier-1, so the live
 *  nodecount.t1_count = these 3 + wireno = 4, and the fast-path quorum is Q = floor(4/2)+1 = 3 —
 *  voting all 3 of these owners clears it. */
const T1_VOTER_NAMES = ["voter1", "voter2", "voter3"] as const

/** The three batch operators whose divergent deliveries form the split. The
 *  operator delivering `CANONICAL_TAG` is the one the Tier-1 owners vote for;
 *  the other two are slashed. These names must match operators the harness
 *  bootstraps (or freshly-provisioned SBP-less ops) — see TODO(live). */
const DISPUTE_OPS = ["dispop.a", "dispop.b", "dispop.c"] as const
const CANONICAL_OP = DISPUTE_OPS[0]
const LOSING_OPS   = [DISPUTE_OPS[1], DISPUTE_OPS[2]]

/** Distinct payload tags -> distinct envelope checksums (no majority). */
const ENVELOPE_TAGS = ["canonical", "fork-1", "fork-2"] as const

const SlashPropagationEpochs = 8

// chain_plugin may return enums as the numeric value or the proto-spelling string.
const isStatus = (raw: unknown, want: OperatorStatus): boolean =>
  match(raw)
    .with(P.number, n => n === want)
    .with(P.string, s => s === `OPERATOR_STATUS_${OperatorStatus[want]}`)
    .otherwise(() => false)

// ──────────────────────────────────────────────────────────────────────
//  Test suite
// ──────────────────────────────────────────────────────────────────────

describe("Flow: Batch operator slashing via OPP envelope dispute vote", () => {
  let ctx: FlowTestContext

  beforeAll(async () => {
    ctx = await FlowTestContext.create({
      epochDurationSec: TEST_EPOCH_DURATION_SEC,
      // Enough bootstrapped batch ops to keep the rest of the network healthy
      // while DISPUTE_OPS drive the contested outpost.
      batchOperatorCount: 9
    })

    // Provision the Tier-1 electorate. Each owner is created with the shared
    // dev K1 key (so the test can sign votes as any of them) and registered
    // T1 via the same path the NFT claim uses (pushNewNamedUser creates the
    // account, pushNodeOwnerReg registers it + inline-bumps nodecount.t1_count
    // — the N that chkdispute reads). See flow-node-owner-nft for the pattern.
    await ctx.wireClient.clio.walletOpenAndUnlock("default")
    for (const owner of T1_VOTER_NAMES) {
      await provisionTier1Voter(owner)
    }

    // Provision the 3 divergent-delivery operators and make them the SOLE active batch-op group, so
    // their (manually pushed) deliveries are the only ones evalcons sees for the contested outpost.
    await provisionDisputeOps()
    await makeDisputeOpsSoleActiveGroup()
  }, BootstrapTimeoutMs)

  afterAll(async () => {
    try {
      await ctx?.teardown()
    } catch (err) {
      log.error("Error during teardown:", err)
    }
    await ProcessManager.get().killAll()
  }, 30_000)

  // ── Chain health ──

  test("WIRE chain is producing blocks", async () => {
    const info = await ctx.wireClient.getInfo()
    expect(Number(info.head_block_num)).toBeGreaterThan(0)
  })

  test("Tier-1 electorate registered", async () => {
    const { rows } = await ctx.wireClient.getTableRows<any>({
      code: "sysio", scope: "sysio", table: "nodecount", limit: 1
    })
    expect(rows.length).toBe(1)
    expect(Number(rows[0].t1_count)).toBeGreaterThanOrEqual(T1_VOTER_NAMES.length)
  })

  // ── 1. Force the 3-way split -> dispute opens + epoch pauses ──

  test(
    "three divergent deliveries open a dispute and pause the epoch",
    async () => {
      // A dispute opens ONLY from deliver's inline evalcons, and only when that deliver lands with
      // now >= next_epoch_start (chkcons does NOT open disputes). The SBP-less group never reaches
      // consensus, so the epoch is stuck at E and current_epoch_index stays E — wait past E's boundary,
      // then deliver, so the 3rd contested-outpost deliver opens the dispute. Also deliver a CONSISTENT
      // envelope for the non-contested outpost (SOLANA) so it reaches Option-A consensus for epoch E:
      // the chkcons advance where the slash runs requires EVERY active outpost to have epoch-E consensus.
      await waitPastEpochBoundary()
      const epoch = await currentEpoch()
      await deliverConsensus(nonContestedChainCode(), epoch)
      await injectDivergentDeliveries(epoch)

      await pollUntil(
        "an OPEN dispute row appears for the contested (outpost, epoch)",
        async () => (await findOpenDispute(epoch)) != null,
        TEST_EPOCH_DURATION_SEC * 2 * MsPerSecond,
        LongPollIntervalMs
      )
      const dispute = await findOpenDispute(epoch)
      expect(dispute).toBeTruthy()
      expect(dispute!.candidates.length).toBeGreaterThanOrEqual(3)

      // chalg::opendispute inline-called epoch::pause.
      const paused = await epochPaused()
      expect(paused).toBe(true)
    },
    TEST_EPOCH_DURATION_SEC * 3 * MsPerSecond + PollDeadlineBufferMs
  )

  // ── 2 + 3. Tier-1 vote -> chkdispute resolves -> winner dispatched + unpause ──

  test(
    "tier-1 vote resolves the dispute to the canonical checksum and unpauses",
    async () => {
      const epoch   = await currentEpoch()
      const dispute = await findOpenDispute(epoch)
      expect(dispute).toBeTruthy()

      const canonicalChecksum = checksumForTag("canonical", dispute!.candidates)
      expect(canonicalChecksum).toBeTruthy()

      // All provisioned Tier-1 owners vote for the canonical checksum — 3 votes clears the live
      // quorum Q = floor(nodecount.t1_count/2)+1 (= 3 with the 3 voters + wireno).
      for (const owner of T1_VOTER_NAMES) {
        await pushVote(owner, dispute!.id, canonicalChecksum!)
      }
      await pollUntil(
        "dispute resolves to the canonical winner",
        async () => {
          // Re-crank the permissionless tally each poll until the votes are tallied and it resolves.
          try { await pushCheckDispute(dispute!.id) } catch { /* already resolving/resolved */ }
          const d = await readDispute(dispute!.id)
          return d != null
            && String(d.status).endsWith("RESOLVED")
            && d.winning_checksum === canonicalChecksum
        },
        TEST_EPOCH_DURATION_SEC * 2 * MsPerSecond,
        LongPollIntervalMs
      )

      // resolvedisp dispatched the winner; chkdispute unpaused the epoch.
      await pollUntil(
        "epoch unpauses after resolution",
        async () => (await epochPaused()) === false,
        TEST_EPOCH_DURATION_SEC * 2 * MsPerSecond,
        LongPollIntervalMs
      )
    },
    TEST_EPOCH_DURATION_SEC * 4 * MsPerSecond + PollDeadlineBufferMs
  )

  // ── 4. Single slash path in advance: losers SLASHED, winner untouched ──

  test(
    "non-canonical deliverers are slashed; the canonical deliverer is not",
    async () => {
      // The slash runs in sysio.epoch::advance once the unpaused epoch advances.
      for (const op of LOSING_OPS) {
        await pollUntil(
          `${op} (non-canonical) becomes SLASHED`,
          async () => {
            // The slash runs in sysio.epoch::advance; chkcons drives advance and the SBP-less group
            // means nothing else cranks it, so drive it here until the unpaused epoch advances.
            await crankConsensus()
            const { rows } = await ctx.wireClient.getOperators()
            const o = rows.find((r: any) => r.account === op)
            return o != null && isStatus(o.status, OperatorStatus.SLASHED)
          },
          TEST_EPOCH_DURATION_SEC * SlashPropagationEpochs * MsPerSecond,
          LongPollIntervalMs
        )
      }

      const { rows } = await ctx.wireClient.getOperators()
      const canonical = rows.find((r: any) => r.account === CANONICAL_OP)
      expect(canonical).toBeDefined()
      // Canonical deliverer must NOT be slashed (may be ACTIVE/UNKNOWN, never SLASHED).
      expect(isStatus(canonical.status, OperatorStatus.SLASHED)).toBe(false)
    },
    TEST_EPOCH_DURATION_SEC * SlashPropagationEpochs * MsPerSecond + PollDeadlineBufferMs
  )

  // ──────────────────────────────────────────────────────────────────────
  //  Helpers
  // ──────────────────────────────────────────────────────────────────────

  /** Create + register a Tier-1 node owner (the dispute electorate). */
  async function provisionTier1Voter(owner: string): Promise<void> {
    // wire_pub_key = shared dev K1 key (loaded into kiod) so the test can sign votes as any owner.
    // eth_pub_key MUST be a PUB_EM_* (secp256k1) — nodeownreg records it as the authex link and asserts
    // it is an EM key; a throwaway random EM key per owner satisfies that (it is never signed with).
    await pushNewNamedUser(ctx.wireClient.clio, owner, DEV_K1_PUBLIC_KEY, NodeOwnerTier.T1)
    await pushNodeOwnerReg(
      ctx.wireClient.clio, owner, NodeOwnerTier.T1, freshEthPubEm(), DEV_K1_PUBLIC_KEY
    )
  }

  /**
   * Provision the 3 divergent-delivery ops as NON-bootstrapped (SBP-less) batch operators. No nodeop
   * runs for them, so they never auto-deliver — the test pushes their deliveries by hand. With
   * `req_batchop_collat` empty (this flow does not set it), they auto-flip ACTIVE on the next
   * eligibility crank (no collateral deposits needed).
   */
  async function provisionDisputeOps(): Promise<void> {
    for (let i = 0; i < DISPUTE_OPS.length; i++) {
      await provisionFreshBatchOperator(ctx, {
        account:    DISPUTE_OPS[i],
        ethHdIndex: DISPUTE_OP_HD_BASE + i
      })
    }
  }

  /**
   * Reconfigure the epoch to ONE group of 3 and rebuild the groups so the sole active batch-op group is
   * exactly the 3 dispute ops. `schbatchgps` sorts non-bootstrapped ops first, then by name, so the
   * three non-bootstrapped `dispop.*` fill the single group (the bootstrapped harness ops sort after and
   * fall outside it). `deliver` is gated to the active group, so only these 3 can deliver — and being
   * SBP-less, only when the test tells them to. `sysio.epoch@active` resolves to `sysio@active` (the
   * governance key loaded in kiod), so the test can sign setconfig / schbatchgps.
   */
  async function makeDisputeOpsSoleActiveGroup(): Promise<void> {
    await ctx.wireClient.clio.pushAction(
      "sysio.epoch",
      "setconfig",
      {
        epoch_duration_sec:                 TEST_EPOCH_DURATION_SEC,
        operators_per_epoch:                DISPUTE_OPS.length,
        batch_operator_minimum_active:      DISPUTE_OPS.length,
        batch_op_groups:                    1,
        epoch_retention_envelope_log_count: 200
      },
      "sysio.epoch"
    )

    // Force the 3 SBP-less ops ACTIVE. Normally an op flips UNKNOWN->ACTIVE via reevaluate_eligibility,
    // which only fires on a deposit event; these ops post no collateral, so nothing would ever evaluate
    // them. opreg::processbatch(account, was_eligible=false, is_eligible=true) IS the eligibility
    // callback and flips status directly; it only needs sysio.opreg auth (= sysio@active = the kiod dev
    // key in-cluster). They carry no bond, which is fine — the dispute test asserts the SLASHED status
    // flip, not a bond amount.
    for (const op of DISPUTE_OPS) {
      await ctx.wireClient.clio.pushAction(
        "sysio.opreg",
        "processbatch",
        { account: op, was_eligible: false, is_eligible: true },
        "sysio.opreg"
      )
    }

    for (const op of DISPUTE_OPS) {
      await pollUntil(
        `${op} is ACTIVE`,
        async () => {
          const { rows } = await ctx.wireClient.getOperators()
          const o = rows.find((r: any) => r.account === op)
          return o != null && isStatus(o.status, OperatorStatus.ACTIVE)
        },
        TEST_EPOCH_DURATION_SEC * 2 * MsPerSecond,
        LongPollIntervalMs
      )
    }

    // Rebuild the groups now that the 3 ops are ACTIVE so they form the single active group.
    await ctx.wireClient.clio.pushAction("sysio.epoch", "schbatchgps", {}, "sysio.epoch")

    await pollUntil(
      "the 3 dispute ops are exactly the active batch-op group",
      async () => {
        const { rows } = await ctx.wireClient.getTableRows<any>({
          code: "sysio.epoch", scope: "sysio.epoch", table: "epochstate", limit: 1
        })
        const groups: string[][] = (rows[0] as any)?.batch_op_groups ?? []
        const active = groups[0] ?? []
        return (
          active.length === DISPUTE_OPS.length &&
          DISPUTE_OPS.every(op => active.includes(op))
        )
      },
      TEST_EPOCH_DURATION_SEC * 5 * MsPerSecond,
      LongPollIntervalMs
    )
  }

  /**
   * Push three `sysio.msgch::deliver` actions — one per DISPUTE_OP — each with a
   * DISTINCT envelope payload for the same (outpost, epoch), forming a 3-way
   * split with no majority.
   *
   * TODO(live): finalize against a running cluster —
   *   (a) Encode three valid OPP Envelopes for `epoch` whose only difference is
   *       a benign payload byte (so the three sha256 checksums differ). Use the
   *       `@wireio/opp-typescript-models` Envelope encoder; the depot recomputes
   *       sha256(data) trustlessly, so any well-formed, epoch-matching envelope
   *       works.
   *   (b) Ensure DISPUTE_OPS are the SOLE deliverers for the contested outpost
   *       this epoch (provision them SBP-less like flow-batch-operator-
   *       termination's freshop, or suppress the bootstrapped SBPs for this
   *       outpost) — otherwise the consistent SBP deliveries form a majority and
   *       no dispute opens.
   */
  async function injectDivergentDeliveries(epoch: number): Promise<void> {
    for (let i = 0; i < DISPUTE_OPS.length; i++) {
      const op   = DISPUTE_OPS[i]
      const tag  = ENVELOPE_TAGS[i]
      const data = encodeDivergentEnvelope(epoch, tag) // TODO(live): real Envelope bytes
      await ctx.wireClient.clio.pushAction(
        "sysio.msgch",
        "deliver",
        { batch_op_name: op, chain_code: contestedChainCode(), data: bytesToHex(data) },
        op
      )
    }
  }

  async function pushVote(owner: string, disputeId: number, chosenChecksum: string): Promise<void> {
    await ctx.wireClient.clio.pushAction(
      "sysio.chalg",
      "votedispute",
      { owner, dispute_id: disputeId, chosen_checksum: chosenChecksum },
      owner
    )
  }

  async function pushCheckDispute(disputeId: number): Promise<void> {
    // Permissionless — sign as any account with a loaded key (a DISPUTE_OP works).
    await ctx.wireClient.clio.pushAction(
      "sysio.chalg",
      "chkdispute",
      { dispute_id: disputeId },
      DISPUTE_OPS[0]
    )
  }

  /**
   * Crank consensus: `sysio.msgch::chkcons` (permissionless, no args) re-runs evalcons for the current
   * epoch's outposts and drives epoch advance. With the 3 dispute ops SBP-less, nothing else cranks it,
   * so the test does — to open the dispute past the boundary and to drive the post-resolution `advance`
   * where the slash runs. Tolerant of transient errors (e.g. a duplicate tx landing in the same block)
   * so it is safe to call inside a poll.
   */
  async function crankConsensus(): Promise<void> {
    try {
      await ctx.wireClient.clio.pushAction("sysio.msgch", "chkcons", {}, DISPUTE_OPS[0])
    } catch {
      /* transient — keep polling */
    }
  }

  /** Wait until wall-clock is past the current epoch's `next_epoch_start`. The SBP-less dispute group
   *  never reaches consensus, so the epoch stays put — and only a deliver landing past the boundary
   *  opens a dispute (chkcons can't). Chain timestamps are UTC; append `Z` if missing. */
  async function waitPastEpochBoundary(): Promise<void> {
    await pollUntil(
      "epoch boundary passes (now >= next_epoch_start)",
      async () => {
        const st  = await ctx.wireClient.getEpochState()
        const raw = String((st.rows[0] as any).next_epoch_start)
        const next = Date.parse(raw.endsWith("Z") ? raw : `${raw}Z`)
        return Number.isFinite(next) && Date.now() >= next
      },
      TEST_EPOCH_DURATION_SEC * 2 * MsPerSecond,
      1_000
    )
  }

  /** Deliver an IDENTICAL envelope for `chainCode`@`epoch` from all 3 dispute ops -> one checksum ->
   *  Option-A consensus for that outpost. Used for the non-contested outpost so that, once the
   *  contested dispute resolves, EVERY active outpost has epoch-E consensus and chkcons can advance
   *  (the slash runs in that advance). */
  async function deliverConsensus(chainCode: number, epoch: number): Promise<void> {
    const data = bytesToHex(encodeDivergentEnvelope(epoch, "consensus"))
    for (const op of DISPUTE_OPS) {
      await ctx.wireClient.clio.pushAction(
        "sysio.msgch",
        "deliver",
        { batch_op_name: op, chain_code: chainCode, data },
        op
      )
    }
  }

  // ── reads ──

  type DisputeRow = {
    id: number
    chain_code: number
    epoch_index: number
    status: string
    winning_checksum: string
    candidates: Array<{ checksum: string; operators: string[] }>
  }

  async function readDispute(id: number): Promise<DisputeRow | undefined> {
    const { rows } = await ctx.wireClient.getTableRows<DisputeRow>({
      code: "sysio.chalg", scope: "sysio.chalg", table: "disputes", limit: 100
    })
    return rows.find(r => Number(r.id) === id)
  }

  async function findOpenDispute(epoch: number): Promise<DisputeRow | undefined> {
    const { rows } = await ctx.wireClient.getTableRows<DisputeRow>({
      code: "sysio.chalg", scope: "sysio.chalg", table: "disputes", limit: 100
    })
    return rows.find(
      r => Number(r.epoch_index) === epoch && String(r.status).endsWith("OPEN")
    )
  }

  function checksumForTag(
    tag: string,
    candidates: Array<{ checksum: string; operators: string[] }>
  ): string | undefined {
    // The canonical candidate is the one CANONICAL_OP delivered.
    const cand = candidates.find(c => c.operators.includes(CANONICAL_OP))
    return cand?.checksum
  }

  async function currentEpoch(): Promise<number> {
    const st = await ctx.wireClient.getEpochState()
    return Number((st.rows[0] as any).current_epoch_index)
  }

  async function epochPaused(): Promise<boolean> {
    const st = await ctx.wireClient.getEpochState()
    return Boolean((st.rows[0] as any).is_paused)
  }
})

// ──────────────────────────────────────────────────────────────────────
//  Encoding stubs — finalize against the live OPP models (TODO(live))
// ──────────────────────────────────────────────────────────────────────

/** slug_name uint64 of the contested outpost. ETHEREUM is one of the two outposts the production
 *  bootstrap registers + activates; its slug fits a JS number (58623385699589). */
function contestedChainCode(): number {
  return Number(SlugName.from("ETHEREUM"))
}

/** slug_name of a non-contested active outpost (SOLANA). The dispute ops deliver a CONSISTENT envelope
 *  here so this outpost reaches epoch-E consensus — chkcons advance (where the slash runs) requires
 *  every active outpost to have consensus for the epoch being advanced out. */
function nonContestedChainCode(): number {
  return Number(SlugName.from("SOLANA"))
}

/**
 * Encode a valid OPP Envelope for `epoch` whose only varying content is `tag`, so the depot's
 * `sha256(data)` differs per tag (that is what produces the 3 distinct candidate checksums).
 *
 * Mirrors `contracts/tests/sysio.dispute_tests.cpp::encode_envelope`: one message carrying one benign
 * `ATTESTATION_TYPE_UNSPECIFIED` attestation whose `data` is the tag. UNSPECIFIED makes the winner's
 * eventual dispatch a no-op (no side effects). The depot validates only `epoch_index == current epoch`
 * and recomputes the checksum trustlessly, so any well-formed, epoch-matching envelope is accepted.
 */
function encodeDivergentEnvelope(epoch: number, tag: string): Uint8Array {
  const data = new TextEncoder().encode(tag)
  return Envelope.toBinary(
    Envelope.create({
      epochIndex: epoch,
      epochEnvelopeIndex: 1,
      epochTimestamp: 1_775_612_516_983n,
      messages: [
        {
          payload: {
            version: 0,
            attestations: [
              { type: AttestationType.UNSPECIFIED, dataSize: data.length, data }
            ]
          }
        }
      ]
    })
  )
}

function bytesToHex(b: Uint8Array): string {
  return Buffer.from(b).toString("hex")
}
