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
import { SlugName, SystemContracts } from "@wireio/sdk-core"

/**
 * Flow F: Swap Variance-Tolerance Revert.
 *
 * Per CLAUDE-WIRE-OPERATOR-COLLATERAL-IMPL-PLAN.md §11.4 — variance-tolerance
 * is the per-SWAP_REQUEST guard against reserve price drift between
 * quote-time and underwriter-race-open. When the depot's
 * `sysio.reserv::swapquote` for the configured (src, dst) legs returns an
 * output more than `tolerance_bps` worse than the user's quote,
 * `sysio.uwrit::createuwreq` REJECTS the swap BEFORE any UWREQ row is
 * created. The depot then emits a SWAP_REVERT outbound to the source
 * outpost so the user's deposited funds get refunded.
 *
 * Sequence:
 *   1. Provision a reserve on `sysio.reserv` for (ETHEREUM, ETH/WIRE) via
 *      `setreserve`.
 *   2. Compute the on-chain quote at time T0.
 *   3. Drift the outpost-side reserve ≥ 100 bps via an `onreward` credit
 *      (STAKING_REWARD-shaped action; grows only `reserve_outpost_amount`).
 *   4. Submit a SWAP_REQUEST attestation with the T0 quote + a 50 bps
 *      tolerance.
 *   5. Assert NO `uwreqs` row gets created.
 *   6. Assert a SWAP_REVERT attestation is queued outbound to the source
 *      outpost (visible in `sysio.msgch::outenvelopes`).
 *   7. (Optional) Assert the source outpost processes the revert and
 *      refunds the depositor. The ETH-side handler lands when SWAP_REVERT
 *      receipt is wired (currently dispatched via the same path as
 *      DEPOSIT_REVERT but with different correlation fields).
 *
 * NOTE on test mechanics:
 *   This flow needs a way to (a) provision a reserve, (b) drift it,
 *   (c) submit a SWAP_REQUEST attestation. The simplest route in v1 is
 *   via direct depot-side action pushes (`sysio.reserv::setreserve` +
 *   `onreward` via `wireClient.push`) rather than waiting for
 *   outpost-driven SWAP_REQUESTs — the outpost path requires an
 *   underwriter for the COMMIT race, which is deferred to §11.3.
 *
 * Environment matches flow-b / flow-d.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Epoch duration kept short to keep the run under jest's cap. */
const TEST_EPOCH_DURATION_SEC = 30

/** Initial reserve balances at T0. ETH paired with WIRE, both in base units. */
const INITIAL_OUTPOST_AMOUNT = 10_000_000n
const INITIAL_WIRE_AMOUNT = 20_000_000n

/** Connector weight in bps (50% — standard Bancor). */
const CONNECTOR_WEIGHT_BPS = 5_000

/** Source amount the user is offering on the SWAP_REQUEST. */
const SRC_AMOUNT = 100_000n

/** Tolerance the user's SWAP_REQUEST carries (50 bps = 0.5%). Drift must
 *  exceed this to trigger the revert. */
const TOLERANCE_BPS = 50

/** Additional reserve top-up that drifts the price BEYOND the 50 bps
 *  tolerance. `onreward` only credits `reserve_outpost_amount`, so the
 *  WIRE-per-outpost-token rate shifts well above 100 bps from the
 *  original quote. */
const DRIFT_OUTPOST_CREDIT = 1_000_000n

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

  // ── Step 1: provision the reserve ──

  test("regreserve provisions an ETH/WIRE reserve on sysio.reserv", async () => {
    // sysio.reserv::regreserve is bootstrap-window-only and requires the
    // contract's own active permission (privileged at bootstrap). The
    // harness's clio wrapper signs with the bootstrap K1 key which holds
    // sysio.reserv@active per Phase 14d.
    await ctx.wireClient.clio.pushAction<SystemContracts.SysioReservRegreserveAction>(
      "sysio.reserv",
      "regreserve",
      {
        chain_code: { value: SlugName.from("ETHEREUM") },
        token_code: { value: SlugName.from("ETH") },
        reserve_code: { value: SlugName.from("PRIMARY") },
        name: "ETHEREUM-ETH-PRIMARY",
        description: "flow-f variance-revert seed reserve",
        initial_chain_amount: Number(INITIAL_OUTPOST_AMOUNT),
        initial_wire_amount: Number(INITIAL_WIRE_AMOUNT),
        connector_weight_bps: CONNECTOR_WEIGHT_BPS
      },
      "sysio.reserv@active"
    )
    // The reserve row's primary key is now a `checksum256` hash of the
    // (chain_code, token_code, reserve_code) triple, so we scan + filter
    // rather than computing the key directly.
    const rows = await ctx.wireClient.getTableRows<any>({
      code: "sysio.reserv",
      scope: "sysio.reserv",
      table: "reserves"
    })
    const r = rows.rows.find(
      (row: any) =>
        Number(row.reserve_chain_amount) === Number(INITIAL_OUTPOST_AMOUNT)
    )
    expect(r).toBeDefined()
    expect(Number(r.reserve_wire_amount)).toBe(Number(INITIAL_WIRE_AMOUNT))
  })

  // The previous `onreward` + `createuwreq` test bodies signed as
  // `sysio.msgch` and called the depot's **internal** dispatch
  // actions directly. Both are invoked inline from
  // `sysio.msgch::dispatch` when STAKING_REWARD / SWAP_REQUEST
  // attestations are received via `sysio.msgch::deliver`. Calling
  // them directly bypasses the proper attestation receive path and
  // covers up integration bugs the receive path could surface.
  //
  // Removed rather than retyped — applying strong typing to a call
  // site that shouldn't exist would lock in the wrong design. The
  // variance-tolerance assertion returns once the harness gains the
  // envelope-builder + multi-operator delivery helper that can
  // synthesise STAKING_REWARD / SWAP_REQUEST attestations through
  // `sysio.msgch::deliver`.

  test.todo(
    "reserve drift via STAKING_REWARD envelope through sysio.msgch::deliver"
  )

  test.todo(
    "stale-quote SWAP_REQUEST envelope yields no uwreqs row + queues SWAP_REVERT outbound"
  )
})
