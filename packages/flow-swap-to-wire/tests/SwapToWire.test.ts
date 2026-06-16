import "jest"
import { ethers } from "ethers"
import {
  FlowTestContext,
  log,
  pollUntil,
  ProcessManager,
  ensureSwapUserIdentities,
  provisionWireUser,
  requestEthereumSwap,
  SwapUserIdentities,
  WireUser
} from "@wireio/test-cluster-tool"
import { UnderwriteRequestStatus } from "@wireio/opp-typescript-models"
import { SlugName } from "@wireio/sdk-core"
import { Timing, Reserves, SwapAmounts, Variance, Accounts } from "./constants.js"

/**
 * Flow: Swap TO WIRE — Ethereum → the WIRE depot itself.
 *
 * The single-leg shape: the user deposits native ETH on the source
 * outpost exactly like a normal swap, but the target is the WIRE token on
 * the depot. Only the SOURCE leg is underwritten (one UIC, one bond, one
 * lock); at race resolution the depot books the source reserve
 * (`chain += src, wire -= dst`) and pays the recipient REAL WIRE from
 * `sysio.reserv` custody in the same transaction. No destination outpost,
 * no SWAP_REMIT, no ack — and the underwriter's collateral lock PERSISTS
 * for its wall-clock challenge window (it is never released by delivery).
 */
describe("Flow: Swap TO WIRE (Ethereum → WIRE depot)", () => {
  let context: FlowTestContext
  let users: SwapUserIdentities
  let recipient: WireUser
  let reserveManager: ethers.Contract

  const slugValue = (v: unknown): number =>
    typeof v === "object" && v !== null && "value" in v
      ? Number((v as { value: unknown }).value)
      : Number(v)

  /** The ETHEREUM/ETH/PRIMARY row from sysio.reserv. */
  async function ethReserveRow(): Promise<any> {
    const { rows } = await context.wireClient.getTableRows<any>({
      code: "sysio.reserv", scope: "sysio.reserv", table: "reserves"
    })
    return rows.find((r: any) =>
      slugValue(r.chain_code) === Reserves.Ethereum.ETH.ChainCode &&
      slugValue(r.token_code) === Reserves.Ethereum.ETH.TokenCode &&
      slugValue(r.reserve_code) === Reserves.Ethereum.ETH.ReserveCode
    )
  }

  /** The to-WIRE uwreq row (src=ETHEREUM, dst=WIRE). */
  async function toWireUwreq(): Promise<any> {
    const { rows } = await context.wireClient.getTableRows<any>({
      code: "sysio.uwrit", scope: "sysio.uwrit", table: "uwreqs"
    })
    return rows.find((r: any) =>
      slugValue(r.src_chain_code) === Reserves.Ethereum.ETH.ChainCode &&
      slugValue(r.dst_chain_code) === Reserves.Wire.ChainCode
    )
  }

  async function locksForUwreq(uwreqId: number): Promise<any[]> {
    const { rows } = await context.wireClient.getTableRows<any>({
      code: "sysio.uwrit", scope: "sysio.uwrit", table: "locks"
    })
    return rows.filter((l: any) => Number(l.uwreq_id) === uwreqId)
  }

  beforeAll(async () => {
    context = await FlowTestContext.create({
      epochDurationSec: Timing.EpochDurationSec,
      reqUwCollat: [
        {
          chainCode: SlugName.from("ETHEREUM"),
          tokenCode: SlugName.from("ETH"),
          minBond: 1_000_000_000
        },
        {
          chainCode: SlugName.from("SOLANA"),
          tokenCode: SlugName.from("SOL"),
          minBond: 1_000_000_000
        }
      ]
    })
    users = await ensureSwapUserIdentities(context)

    // The WIRE recipient only needs to EXIST — the payout is the flow's
    // proof, so it starts at zero WIRE.
    recipient = await provisionWireUser(context.wireClient.clio, Accounts.Recipient)

    const ethAddrs = context.loadETHAddresses()
    reserveManager = context.loadETHContract("ReserveManager", ethAddrs.ReserveManager)
      .connect(users.ethereumWallet) as ethers.Contract
  }, Timing.BootstrapTimeoutMs)

  afterAll(async () => {
    try {
      await context?.teardown()
    } catch (err) {
      log.error("Error during teardown:", err)
    }
    await ProcessManager.get().killAll()
  }, 30_000)

  // ── Phase 0: substrate health ───────────────────────────────────────────

  test("WIRE chain is producing blocks", async () => {
    const info = await context.wireClient.getInfo()
    expect(Number(info.head_block_num)).toBeGreaterThan(0)
  })

  test("bootstrap seeded the ETHEREUM/ETH/PRIMARY reserve with real WIRE custody", async () => {
    const row = await ethReserveRow()
    expect(row).toBeDefined()
    // Custody prerequisite for the direct payout: sysio.reserv's REAL
    // WIRE balance backs the reserve rows (regreserve treasury drain).
    const custody = await context.wireClient.getWireBalance("sysio.reserv")
    expect(custody).toBeGreaterThanOrEqual(BigInt(row.reserve_wire_amount))
  })

  test("uwrit.a becomes ACTIVE (deposits credit)", async () => {
    await pollUntil(
      "uwrit.a ACTIVE",
      async () => {
        const { rows } = await context.wireClient.getTableRows<any>({
          code: "sysio.opreg", scope: "sysio.opreg", table: "operators"
        })
        const uw = rows.find((r: any) => r.account === "uwrit.a")
        if (!uw) return false
        return Number(uw.status) === 1 ||
          uw.status === "OPERATOR_STATUS_ACTIVE" ||
          uw.status === 1
      },
      Timing.UwreqDeadlineMs,
      Timing.LongPollIntervalMs
    )
  }, Timing.UwreqDeadlineMs + 30_000)

  // ── The swap ────────────────────────────────────────────────────────────

  let targetWireAmount: bigint
  let reserveBefore: { chain: bigint; wire: bigint }
  let reservCustodyBefore: bigint

  test("compute the to-WIRE target from the source reserve curve", async () => {
    // The public reserv::swapquote is two-reserve; a WIRE target has no
    // destination reserve, so the depot's variance check uses the
    // single-reserve branch `cp_output(src.chain, src.wire, amount)`.
    // Mirror that math here from the live row.
    const row = await ethReserveRow()
    reserveBefore = {
      chain: BigInt(row.reserve_chain_amount),
      wire: BigInt(row.reserve_wire_amount)
    }
    reservCustodyBefore = await context.wireClient.getWireBalance("sysio.reserv")
    const amt = SwapAmounts.SourceDepotUnits
    targetWireAmount =
      (reserveBefore.wire * amt) / (reserveBefore.chain + amt)
    expect(targetWireAmount).toBeGreaterThan(0n)
    log.info(`[ToWire] curve target = ${targetWireAmount} WIRE base units`)
  })

  test("user calls ReserveManager.requestSwap with the WIRE target", async () => {
    const result = await requestEthereumSwap(reserveManager as any, {
      sourceTokenCode:    BigInt(Reserves.Ethereum.ETH.TokenCode),
      sourceReserveCode:  BigInt(Reserves.Ethereum.ETH.ReserveCode),
      sourceAmountWei:    SwapAmounts.SourceEthereumWei,
      targetChainCode:    BigInt(Reserves.Wire.ChainCode),
      targetTokenCode:    BigInt(Reserves.Wire.TokenCode),
      // Non-zero sentinel — the outpost guards reserveCode != 0; the
      // depot never quotes or debits a WIRE-side reserve.
      targetReserveCode:  BigInt(Reserves.Wire.SentinelReserveCode),
      targetRecipient:    recipient.accountBytes,
      targetAmount:       targetWireAmount,
      targetToleranceBps: Variance.ToleranceBps
    })
    expect(result.transactionHash).toBeTruthy()
  })

  test("depot creates the PENDING to-WIRE UWREQ", async () => {
    await pollUntil(
      "to-WIRE UWREQ row appears",
      async () => (await toWireUwreq()) !== undefined,
      Timing.UwreqDeadlineMs,
      Timing.LongPollIntervalMs
    )
    const row = await toWireUwreq()
    expect(slugValue(row.dst_token_code)).toBe(Reserves.Wire.TokenCode)
  }, Timing.UwreqDeadlineMs + 30_000)

  test("single-leg race resolves: CONFIRMED with exactly ONE lock (source leg)", async () => {
    await pollUntil(
      "to-WIRE UWREQ status=CONFIRMED",
      async () => {
        const row = await toWireUwreq()
        if (!row) return false
        return Number(row.status) === UnderwriteRequestStatus.CONFIRMED ||
          row.status === "UNDERWRITE_REQUEST_STATUS_CONFIRMED"
      },
      Timing.RaceDeadlineMs,
      Timing.LongPollIntervalMs
    )
    const row = await toWireUwreq()
    const locks = await locksForUwreq(Number(row.id))
    // The WIRE leg carries no bond — only the ETH source leg is locked.
    expect(locks).toHaveLength(1)
    expect(slugValue(locks[0].chain_code)).toBe(Reserves.Ethereum.ETH.ChainCode)
  }, Timing.RaceDeadlineMs + 30_000)

  test("recipient receives REAL WIRE and the books moved at emit", async () => {
    await pollUntil(
      "recipient WIRE balance bump",
      async () =>
        (await context.wireClient.getWireBalance(recipient.account)) >= targetWireAmount,
      Timing.PayoutDeadlineMs,
      Timing.LongPollIntervalMs
    )
    const received = await context.wireClient.getWireBalance(recipient.account)
    // paywire pays dst_amount exactly (the user's variance-gated target).
    expect(received).toBe(targetWireAmount)

    // Source reserve books: chain += src, wire -= paid — applied in the
    // SAME transaction as the race resolution (emit-time settlement).
    const row = await ethReserveRow()
    expect(BigInt(row.reserve_chain_amount))
      .toBe(reserveBefore.chain + SwapAmounts.SourceDepotUnits)
    expect(BigInt(row.reserve_wire_amount))
      .toBe(reserveBefore.wire - targetWireAmount)

    // Custody invariant: Σ reserve_wire_amount and the REAL balance
    // dropped together.
    const custodyAfter = await context.wireClient.getWireBalance("sysio.reserv")
    expect(custodyAfter).toBe(reservCustodyBefore - targetWireAmount)
  }, Timing.PayoutDeadlineMs + 30_000)

  test("the source-leg lock PERSISTS after payout (challenge window)", async () => {
    const row = await toWireUwreq()
    const locks = await locksForUwreq(Number(row.id))
    // Locks are a wall-clock challenge window — delivery does NOT release
    // them. (chklocks sweeps them after collateral_lock_duration_ms.)
    expect(locks).toHaveLength(1)
    // And the uwreq stays CONFIRMED until that window elapses.
    expect(
      Number(row.status) === UnderwriteRequestStatus.CONFIRMED ||
      row.status === "UNDERWRITE_REQUEST_STATUS_CONFIRMED"
    ).toBe(true)
  })

  test("no outbound SWAP_REMIT was queued for the to-WIRE uwreq", async () => {
    // The depot itself is the payer — nothing rides OPP for the WIRE leg.
    const row = await toWireUwreq()
    const { rows } = await context.wireClient.getTableRows<any>({
      code: "sysio.msgch", scope: "sysio.msgch", table: "attestations"
    })
    const remitForUwreq = rows.find((a: any) => {
      if (a.attest_type !== "ATTESTATION_TYPE_SWAP_REMIT" &&
          Number(a.attest_type) !== 60944) return false
      const data: string = a.data ?? ""
      // SwapRemit.original_message_id low 8 bytes = uwreq id (LE).
      const idHexLe = Number(row.id).toString(16).padStart(2, "0")
      return typeof data === "string" && data.length > 0 && data.includes(idHexLe)
    })
    expect(remitForUwreq).toBeUndefined()
  })
})
