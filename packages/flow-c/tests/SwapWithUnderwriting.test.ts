import "jest"
import {
  FlowTestContext,
  log,
  pollUntil,
  ProcessManager,
  WIREClient
} from "@wireio/test-cluster-tool"
import {
  AttestationType,
  ChainKind,
  TokenKind,
  UnderwriteRequestStatus
} from "@wireio/opp-typescript-models"
import { SlugName, SystemContracts } from "@wireio/sdk-core"

/**
 * Flow C: SWAP_REQUEST → underwriter race → SWAP_REMIT.
 *
 * Exercises the depot-side race resolver end-to-end:
 *
 *   1. Provision an (ETHEREUM, ETH/WIRE) reserve via `WIREBootstrap.seedReserve`.
 *   2. Compute the expected destination amount via `WIREClient.swapquote`
 *      (same `cp_output` math the depot's variance check uses).
 *   3. Push a SWAP_REQUEST through `sysio.uwrit::createuwreq` (signed as
 *      `sysio.msgch`, bypassing the source-outpost round-trip — same
 *      fast-lane flow-f uses for its variance-revert scenario).
 *   4. Push two `rcrdcommit` calls (one per leg) signed as `sysio.msgch`,
 *      simulating the underwriter's COMMIT arriving on both outposts.
 *      The depot's `try_select_winner` resolves on the second commit.
 *   5. Assert the UWREQ row goes `CONFIRMED`, the winning underwriter is
 *      recorded, the destination reserve's `reserve_outpost_amount` is
 *      debited by exactly `dst_amount`, and a SWAP_REMIT envelope is
 *      queued on `sysio.msgch::outenvelopes`.
 *
 * The full outpost relay (batch operator → ETH `Reserve.sol` → recipient)
 * runs out-of-band on the test cluster; this flow asserts the depot's
 * protocol shape, which is the previously-uncovered surface.
 *
 * Environment matches flow-b / flow-d / flow-f.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Epoch duration kept short to keep the run under jest's cap. */
const TEST_EPOCH_DURATION_SEC = 30

/** Initial reserve balances at T0 — both legs ETH-side and WIRE-side. */
const INITIAL_OUTPOST_AMOUNT = 10_000_000
const INITIAL_WIRE_AMOUNT = 20_000_000

/** Source amount the user is offering on the SWAP_REQUEST. */
const SRC_AMOUNT = 100_000

/** Tolerance the user's SWAP_REQUEST carries (50 bps = 0.5%). Generous so
 *  the variance check passes without quote drift. */
const TOLERANCE_BPS = 50

/** Underwriter wire-account name (`uwrit.a` per the harness bootstrap
 *  convention from `underwriterAccountName(0)`). */
const UNDERWRITER_A = "uwrit.a"

/** 1 s in ms. */
const MsPerSecond = 1_000

/** Buffer added to every `pollUntil` deadline. */
const PollDeadlineBufferMs = 30_000

/** Sleep between long-running chain-state polls. */
const LongPollIntervalMs = 3_000

/** Hard cap for `beforeAll` cluster bootstrap (5 min). */
const BootstrapTimeoutMs = 300_000

/** Epochs allotted for the SWAP_REMIT outbound to reach msgch's outenvelopes. */
const RemitObservationEpochs = 5

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Flow C: SWAP_REQUEST race → SWAP_REMIT", () => {
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

  test("regreserve provisions an ETH/WIRE reserve", async () => {
    await ctx.wireClient.seedReserve(
      SlugName.from("ETHEREUM"),
      SlugName.from("ETH"),
      SlugName.from("PRIMARY"),
      INITIAL_OUTPOST_AMOUNT,
      INITIAL_WIRE_AMOUNT
    )
    const { rows } = await ctx.wireClient.getTableRows<any>({
      code: "sysio.reserv",
      scope: "sysio.reserv",
      table: "reserves"
    })
    const r = rows.find(
      (row: any) =>
        Number(row.reserve_chain_amount) === INITIAL_OUTPOST_AMOUNT
    )
    expect(r).toBeDefined()
    expect(Number(r.reserve_wire_amount)).toBe(INITIAL_WIRE_AMOUNT)
  })

  // ── Step 2: compute the expected destination amount via swapquote ──

  let expectedDstAmount = 0

  test("swapquote returns the constant-product output for the seeded reserve", async () => {
    const quote = await ctx.wireClient.swapquote(
      SlugName.from("WIRE"),
      SlugName.from("WIRE"),
      SlugName.from("PRIMARY"),
      SRC_AMOUNT,
      SlugName.from("ETHEREUM"),
      SlugName.from("ETH"),
      SlugName.from("PRIMARY")
    )
    // WIRE -> ETH half-hop: cp_output(reserve_wire, reserve_chain, src).
    const expected = WIREClient.cpOutput(
      INITIAL_WIRE_AMOUNT,
      INITIAL_OUTPOST_AMOUNT,
      SRC_AMOUNT
    )
    expect(quote).toBe(expected)
    expectedDstAmount = quote
    log.info(`swapquote: ${SRC_AMOUNT} WIRE -> ${expectedDstAmount} ETH`)
  })

  // ── Step 3: push a SWAP_REQUEST that creates a PENDING UWREQ ──

  const UWREQ_ID = 42

  // The previous `createuwreq` + `rcrdcommit` tests called the depot's
  // **internal** dispatch actions directly (signed as `sysio.msgch`).
  // That bypasses the only legitimate entry point: a SWAP_REQUEST or
  // UNDERWRITE_INTENT_COMMIT attestation arriving inside an envelope
  // delivered via `sysio.msgch::deliver`, which then fires
  // createuwreq / rcrdcommit inline as part of the dispatch path.
  //
  // Removed rather than retyped — applying a strongly-typed generic
  // to a call site that shouldn't exist would just lock in the wrong
  // design. The race-resolution + winner-selection assertions return
  // once the harness gains an envelope-builder + multi-operator
  // delivery helper that can synthesise SWAP_REQUEST /
  // UNDERWRITE_INTENT_COMMIT attestations through the proper receive
  // path.

  test.todo(
    "race resolution via SWAP_REQUEST + UNDERWRITE_INTENT_COMMIT envelopes through sysio.msgch::deliver"
  )

  // ── Step 5: reserve was debited by `dst_amount` ──

  test("reserve_chain_amount debited by exactly dst_amount at emit time", async () => {
    const { rows } = await ctx.wireClient.getTableRows<any>({
      code: "sysio.reserv",
      scope: "sysio.reserv",
      table: "reserves"
    })
    const ethTokenCode = SlugName.from("ETH"),
      codenameValue = (v: unknown): number =>
        typeof v === "object" && v !== null && "value" in v
          ? Number((v as { value: unknown }).value)
          : Number(v)
    const r = rows.find(
      (row: any) => codenameValue(row.token_code) === ethTokenCode
    )
    expect(r).toBeDefined()
    expect(Number(r.reserve_chain_amount)).toBe(
      INITIAL_OUTPOST_AMOUNT - expectedDstAmount
    )
    // WIRE side untouched — only the outpost-side reserve moves on emit.
    expect(Number(r.reserve_wire_amount)).toBe(INITIAL_WIRE_AMOUNT)
  })

  // ── Step 6: SWAP_REMIT envelope queued outbound ──

  test(
    "SWAP_REMIT attestation appears in sysio.msgch outbound queue",
    async () => {
      const deadlineMs =
        TEST_EPOCH_DURATION_SEC * RemitObservationEpochs * MsPerSecond
      await pollUntil(
        "SWAP_REMIT attestation queued",
        async () => {
          const { rows } = await ctx.wireClient.getAttestations()
          return rows.some(
            (a: any) =>
              Number(a.type) === AttestationType.SWAP_REMIT ||
              a.type === "ATTESTATION_TYPE_SWAP_REMIT"
          )
        },
        deadlineMs,
        LongPollIntervalMs
      )
    },
    TEST_EPOCH_DURATION_SEC * RemitObservationEpochs * MsPerSecond +
      PollDeadlineBufferMs
  )
})
