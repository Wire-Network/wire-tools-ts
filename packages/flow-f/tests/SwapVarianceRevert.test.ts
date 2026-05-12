import "jest"
import { ethers } from "ethers"
import {
  FlowTestContext,
  pollUntil,
  log,
  ProcessManager
} from "@wireio/test-cluster-tool"
import {
  AttestationType,
  ChainKind,
  TokenKind
} from "@wireio/opp-typescript-models"

/**
 * Flow F: Swap Variance-Tolerance Revert.
 *
 * Per CLAUDE-WIRE-OPERATOR-COLLATERAL-IMPL-PLAN.md §11.4 — variance-tolerance
 * is the per-SWAP guard against LP price drift between quote-time and
 * underwriter-race-open. When the depot's `sysio.reserve::reserve_quote` for
 * the configured (src, dst) legs returns an output more than `tolerance_bps`
 * worse than the user's quote, `sysio.uwrit::createuwreq` REJECTS the swap
 * BEFORE any UWREQ row is created. The depot then emits a SWAP_REVERT
 * outbound to the source outpost so the user's deposited funds get refunded.
 *
 * Sequence:
 *   1. Provision an LP on `sysio.reserve` for (ETHEREUM, ETH/WIRE).
 *   2. Compute the on-chain quote at time T0.
 *   3. Drift the LP price ≥ 100 bps via additional `creditlp` calls.
 *   4. Submit a SWAP attestation with the T0 quote + a 50 bps tolerance.
 *   5. Assert NO `uwreqs` row gets created.
 *   6. Assert a SWAP_REVERT attestation is queued outbound to the source
 *      outpost (visible in `sysio.msgch::outenvelopes`).
 *   7. (Optional) Assert the source outpost processes the revert and
 *      refunds the depositor. The ETH-side handler lands when SWAP_REVERT
 *      receipt is wired (currently dispatched via the same path as
 *      DEPOSIT_REVERT but with different correlation fields).
 *
 * NOTE on test mechanics:
 *   This flow needs a way to (a) provision an LP, (b) drift it, (c) submit
 *   a SWAP attestation. The simplest route in v1 is via direct depot-side
 *   action pushes (sysio.reserve::setlp + creditlp via wireClient.push)
 *   rather than waiting for outpost-driven SWAPs — the outpost path requires
 *   an underwriter for the COMMIT race, which is deferred to §11.3.
 *
 * Environment matches flow-b / flow-d.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Epoch duration kept short to keep the run under jest's cap. */
const TEST_EPOCH_DURATION_SEC = 30

/** Initial LP reserves at T0. ETH paired with WIRE, both in base units. */
const INITIAL_LP_PAIRED = 10_000_000n
const INITIAL_LP_WIRE = 20_000_000n

/** Connector weight in bps (50% — standard Bancor). */
const CONNECTOR_WEIGHT_BPS = 5_000

/** Source amount the user is offering on the SWAP. */
const SRC_AMOUNT = 100_000n

/** Tolerance the user's SWAP carries (50 bps = 0.5%). Drift must exceed
 *  this to trigger the revert. */
const TOLERANCE_BPS = 50

/** Additional LP top-up that drifts the price BEYOND the 50 bps tolerance.
 *  We add a lopsided credit (paired side only) so the WIRE-per-paired rate
 *  shifts well above 100 bps from the original quote. */
const DRIFT_PAIRED_CREDIT = 1_000_000n
const DRIFT_WIRE_CREDIT = 0n

/** 1 s in ms. */
const MsPerSecond = 1_000

/** Buffer added to every `pollUntil` deadline. */
const PollDeadlineBufferMs = 30_000

/** Sleep between long-running chain-state polls. */
const LongPollIntervalMs = 3_000

/** Hard cap for `beforeAll` cluster bootstrap (5 min). */
const BootstrapTimeoutMs = 300_000

/** Epochs allotted for the SWAP_REVERT outbound to reach msgch's outenvelopes. */
const RevertObservationEpochs = 5

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Flow F: Swap Variance-Tolerance Revert", () => {
  let ctx: FlowTestContext

  beforeAll(async () => {
    ctx = await FlowTestContext.create({
      epochDurationSec: TEST_EPOCH_DURATION_SEC
    })
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

  // ── Step 1: provision the LP ──

  test("setlp provisions an ETH/WIRE pool on sysio.reserv", async () => {
    // sysio.reserv::setlp requires the contract's own active permission
    // (privileged at bootstrap). The harness's clio wrapper signs with the
    // bootstrap K1 key which holds sysio.reserv@active per Phase 14d.
    await ctx.wireClient.clio.pushAction(
      "sysio.reserv",
      "setlp",
      {
        chain: ChainKind.ETHEREUM,
        paired_token: TokenKind.ETH,
        reserve_paired: Number(INITIAL_LP_PAIRED),
        reserve_wire: Number(INITIAL_LP_WIRE),
        connector_weight_bps: CONNECTOR_WEIGHT_BPS
      },
      "sysio.reserv@active"
    )
    // The LP row's primary key packs (chain << 32) | paired_token. ETH=2,
    // ETH-token=256 → 2<<32 | 256 = 8589934848. Read it back to confirm.
    const rows = await ctx.wireClient.getTableRows<any>({
      code: "sysio.reserv",
      scope: "sysio.reserv",
      table: "lps"
    })
    const lp = rows.rows.find(
      (r: any) => Number(r.reserve_paired) === Number(INITIAL_LP_PAIRED)
    )
    expect(lp).toBeDefined()
    expect(Number(lp.reserve_wire)).toBe(Number(INITIAL_LP_WIRE))
  })

  // ── Step 2-3: drift the LP price beyond tolerance ──

  test("creditlp drifts the LP rate by more than TOLERANCE_BPS", async () => {
    // sysio.reserv::creditlp expects auth=sysio.msgch (STAKING_REWARD
    // dispatch). For the test we sign as sysio.msgch (the harness wallet
    // holds its key from bootstrap Phase 14a–c).
    await ctx.wireClient.clio.pushAction(
      "sysio.reserv",
      "creditlp",
      {
        chain: ChainKind.ETHEREUM,
        paired_token: TokenKind.ETH,
        paired_amount: Number(DRIFT_PAIRED_CREDIT),
        wire_amount: Number(DRIFT_WIRE_CREDIT)
      },
      "sysio.msgch@active"
    )
    const rows = await ctx.wireClient.getTableRows<any>({
      code: "sysio.reserv",
      scope: "sysio.reserv",
      table: "lps"
    })
    const lp = rows.rows[0]
    expect(Number(lp.reserve_paired)).toBe(
      Number(INITIAL_LP_PAIRED + DRIFT_PAIRED_CREDIT)
    )
  })

  // ── Step 4-5: submit a SWAP with a stale quote — expect rejection ──

  test(
    "createuwreq with stale-quote SWAP yields no uwreqs row + queues SWAP_REVERT outbound",
    async () => {
      // The depot-side variance check happens inside
      // `sysio.uwrit::createuwreq`, dispatched from msgch when an
      // ATTESTATION_TYPE_SWAP_REQUEST envelope is processed. For test
      // purposes we can either:
      //   (a) inject the SWAP_REQUEST attestation through the OPP envelope
      //       path (requires building a complete envelope + delivering via
      //       a batch operator), or
      //   (b) call `sysio.uwrit::createuwreq` directly as sysio.msgch.
      //
      // Path (b) is the fast lane for this scenario — it exercises the
      // variance-check branch without the full envelope round-trip.
      const stalePairedRate =
        Number(INITIAL_LP_WIRE) / Number(INITIAL_LP_PAIRED)
      const staleDstAmount = BigInt(
        Math.floor(Number(SRC_AMOUNT) * stalePairedRate)
      )
      await ctx.wireClient.clio.pushAction(
        "sysio.uwrit",
        "createuwreq",
        {
          attestation_id: 1,
          type: AttestationType.SWAP_REQUEST,
          outpost_id: 0,
          src_chain: ChainKind.ETHEREUM,
          src_token_kind: TokenKind.ETH,
          src_amount: Number(SRC_AMOUNT),
          dst_chain: ChainKind.ETHEREUM,
          dst_token_kind: TokenKind.ETH,
          dst_amount: Number(staleDstAmount),
          tolerance_bps: TOLERANCE_BPS,
          data: []
        },
        "sysio.msgch@active"
      )

      // After the variance check fails, no UWREQ row should land on
      // sysio.uwrit::uwreqs (the action returns before insert).
      const uwreqRows = await ctx.wireClient.getUwRequests()
      expect(uwreqRows.rows.length).toBe(0)

      // SWAP_REVERT outbound should appear in msgch's outenvelopes within
      // a few epochs (the encode + queueout happens inline from
      // createuwreq's revert branch).
      const revertDeadlineMs =
        TEST_EPOCH_DURATION_SEC * RevertObservationEpochs * MsPerSecond
      await pollUntil(
        "SWAP_REVERT attestation appears in outbound queue",
        async () => {
          const { rows } = await ctx.wireClient.getAttestations()
          return rows.some(
            (a: any) =>
              Number(a.type) === AttestationType.SWAP_REVERT ||
              a.type === "ATTESTATION_TYPE_SWAP_REVERT"
          )
        },
        revertDeadlineMs,
        LongPollIntervalMs
      )
    },
    TEST_EPOCH_DURATION_SEC * RevertObservationEpochs * MsPerSecond +
      PollDeadlineBufferMs
  )
})
