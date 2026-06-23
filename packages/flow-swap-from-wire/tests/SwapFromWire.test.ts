import "jest"
import { Connection } from "@solana/web3.js"
import {
  FlowTestContext,
  log,
  pollUntil,
  ProcessManager,
  ensureSwapUserIdentities,
  provisionWireUser,
  SwapUserIdentities,
  WireUser,
  WIREClient
} from "@wireio/test-cluster-tool"
import { UnderwriteRequestStatus } from "@wireio/opp-typescript-models"
import { SlugName, SystemContracts } from "@wireio/sdk-core"
import { Timing, Reserves, SwapAmounts, Variance, Accounts } from "./constants.js"

/**
 * Flow: Swap FROM WIRE — the WIRE depot itself is the source chain.
 *
 * The queued shape: `sysio.uwrit::swapfromwire` escrows the user's REAL
 * WIRE into `sysio.reserv` custody and writes a queue row — NO uwreq
 * exists until the next `sysio.epoch::advance` drains the queue
 * (authoritative re-validation) and emplaces the PENDING uwreq with
 * `src = WIRE`. Underwriters then race the TARGET leg only (one UIC, one
 * bond, one lock); at the win the escrowed WIRE becomes the target
 * reserve's WIRE-side liquidity (`wire += escrow, chain -= dst`) and a
 * normal SWAP_REMIT pays the recipient on Solana.
 */
describe("Flow: Swap FROM WIRE (WIRE depot → Solana)", () => {
  let context: FlowTestContext
  let users: SwapUserIdentities
  let depositor: WireUser
  let solanaConnection: Connection

  const slugValue = (v: unknown): number =>
    typeof v === "object" && v !== null && "value" in v
      ? Number((v as { value: unknown }).value)
      : Number(v)

  async function solReserveRow(): Promise<any> {
    const { rows } = await context.wireClient.getTableRows<any>({
      code: "sysio.reserv", scope: "sysio.reserv", table: "reserves"
    })
    return rows.find((r: any) =>
      slugValue(r.chain_code) === Reserves.Solana.SOL.ChainCode &&
      slugValue(r.token_code) === Reserves.Solana.SOL.TokenCode &&
      slugValue(r.reserve_code) === Reserves.Solana.SOL.ReserveCode
    )
  }

  async function fromWireUwreq(): Promise<any> {
    const { rows } = await context.wireClient.getTableRows<any>({
      code: "sysio.uwrit", scope: "sysio.uwrit", table: "uwreqs"
    })
    return rows.find((r: any) =>
      slugValue(r.src_chain_code) === Reserves.Wire.ChainCode &&
      slugValue(r.dst_chain_code) === Reserves.Solana.SOL.ChainCode
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

    // The depositor escrows real WIRE — fund from the treasury.
    depositor = await provisionWireUser(context.wireClient.clio, Accounts.Depositor, {
      fundWireAmount: Accounts.DepositorFunding
    })

    solanaConnection = new Connection(
      `http://127.0.0.1:${context.ports.solanaRpc}`,
      "confirmed"
    )
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

  test("bootstrap seeded the SOLANA/SOL/PRIMARY reserve", async () => {
    expect(await solReserveRow()).toBeDefined()
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
      Timing.DrainDeadlineMs,
      Timing.LongPollIntervalMs
    )
  }, Timing.DrainDeadlineMs + 30_000)

  // ── The swap ────────────────────────────────────────────────────────────

  let targetSolAmount: bigint
  let depositorWireBefore: bigint
  let reservCustodyBefore: bigint
  let solReserveBefore: { chain: bigint; wire: bigint }
  let solanaBalanceBefore: number

  test("compute the from-WIRE target from the destination reserve curve", async () => {
    // src == WIRE quotes against the DESTINATION reserve only:
    // cp_output(dst.wire, dst.chain, wire_in) — mirror the depot's math.
    const row = await solReserveRow()
    solReserveBefore = {
      chain: BigInt(row.reserve_chain_amount),
      wire: BigInt(row.reserve_wire_amount)
    }
    const amt = SwapAmounts.SourceWireUnits
    targetSolAmount = (solReserveBefore.chain * amt) / (solReserveBefore.wire + amt)
    expect(targetSolAmount).toBeGreaterThan(0n)
    log.info(`[FromWire] curve target = ${targetSolAmount} lamports`)
  })

  test("depositor pushes sysio.uwrit::swapfromwire — WIRE escrows NOW, no uwreq yet", async () => {
    depositorWireBefore = await context.wireClient.getWireBalance(depositor.account)
    reservCustodyBefore = await context.wireClient.getWireBalance("sysio.reserv")
    solanaBalanceBefore = await solanaConnection.getBalance(users.solanaKeypair.publicKey)
    expect(depositorWireBefore).toBeGreaterThanOrEqual(SwapAmounts.SourceWireUnits)

    await context.wireClient.clio.pushActionAndWait<SystemContracts.SysioUwritSwapfromwireAction>(
      "sysio.uwrit",
      "swapfromwire",
      {
        user: depositor.account,
        wire_amount: Number(SwapAmounts.SourceWireUnits),
        dst_chain_code: { value: Reserves.Solana.SOL.ChainCode },
        dst_token_code: { value: Reserves.Solana.SOL.TokenCode },
        dst_reserve_code: { value: Reserves.Solana.SOL.ReserveCode },
        target_amount: Number(targetSolAmount),
        target_tolerance_bps: Variance.ToleranceBps,
        recipient_kind: SystemContracts.SysioUwritChainkind.CHAIN_KIND_SVM,
        recipient_addr: Buffer.from(users.solanaPublicKeyBytes).toString("hex")
      },
      `${depositor.account}@active`
    )

    // Escrow is immediate and REAL: depositor down, custody up.
    const depositorAfter = await context.wireClient.getWireBalance(depositor.account)
    const custodyAfter = await context.wireClient.getWireBalance("sysio.reserv")
    expect(depositorAfter).toBe(depositorWireBefore - SwapAmounts.SourceWireUnits)
    expect(custodyAfter).toBe(reservCustodyBefore + SwapAmounts.SourceWireUnits)
  })

  test("next epoch advance drains the queue into a PENDING uwreq (src=WIRE)", async () => {
    await pollUntil(
      "from-WIRE UWREQ row appears",
      async () => (await fromWireUwreq()) !== undefined,
      Timing.DrainDeadlineMs,
      Timing.LongPollIntervalMs
    )
    const row = await fromWireUwreq()
    expect(slugValue(row.src_token_code)).toBe(Reserves.Wire.TokenCode)
    expect(Number(row.src_amount)).toBe(Number(SwapAmounts.SourceWireUnits))
    // Depot-origin id space: bit 63 tags queued from-WIRE requests.
    expect(BigInt(row.id) & (1n << 63n)).toBe(1n << 63n)
  }, Timing.DrainDeadlineMs + 30_000)

  test("single-leg race resolves: CONFIRMED with exactly ONE lock (target leg)", async () => {
    await pollUntil(
      "from-WIRE UWREQ status=CONFIRMED",
      async () => {
        const row = await fromWireUwreq()
        if (!row) return false
        return Number(row.status) === UnderwriteRequestStatus.CONFIRMED ||
          row.status === "UNDERWRITE_REQUEST_STATUS_CONFIRMED"
      },
      Timing.RaceDeadlineMs,
      Timing.LongPollIntervalMs
    )
    const row = await fromWireUwreq()
    const locks = await locksForUwreq(Number(row.id))
    // The WIRE source leg carries no bond — only the SOL target leg locks.
    expect(locks).toHaveLength(1)
    expect(slugValue(locks[0].chain_code)).toBe(Reserves.Solana.SOL.ChainCode)

    // Emit-time books: the escrow became dst-reserve WIRE liquidity and
    // the chain side was debited BEFORE the remit left the depot. #414's
    // `applyfromwire` skims the WIRE-leg fee off the escrowed input, so the
    // reserve's WIRE side grows by the post-fee NET, not the gross escrow.
    const fromWireFee = WIREClient.splitWireFee(SwapAmounts.SourceWireUnits)
    const reserve = await solReserveRow()
    expect(BigInt(reserve.reserve_wire_amount))
      .toBe(solReserveBefore.wire + fromWireFee.net)
    expect(BigInt(reserve.reserve_chain_amount))
      .toBe(solReserveBefore.chain - targetSolAmount)
  }, Timing.RaceDeadlineMs + 30_000)

  test("recipient's SOL balance bumps by ~targetAmount", async () => {
    await pollUntil(
      "from-WIRE recipient receives SOL",
      async () => {
        const current = await solanaConnection.getBalance(users.solanaKeypair.publicKey)
        const drift = (targetSolAmount * BigInt(Variance.ToleranceBps)) / 10_000n
        return current >= solanaBalanceBefore + Number(targetSolAmount - drift)
      },
      Timing.RemitDeadlineMs,
      Timing.LongPollIntervalMs
    )
    const final = await solanaConnection.getBalance(users.solanaKeypair.publicKey)
    log.info(`[FromWire] recipient received ${final - solanaBalanceBefore} lamports`)
    expect(final - solanaBalanceBefore).toBeGreaterThan(0)
  }, Timing.RemitDeadlineMs + 30_000)

  test("escrowed WIRE stays in custody (it now backs the reserve) and the lock persists", async () => {
    // FROM-WIRE never pays the escrow back out — it became reserve liquidity.
    // Custody holds the deposit MINUS the FULL WIRE-leg fee: the emissions half
    // at emit (#414), and as of #425 the rewards half drained from the rewards
    // bucket each epoch by payepoch (sysio.reserv::drainrewards). That drain can
    // land just after the SOL-recipient remit while the prior poll has already
    // succeeded, so poll until custody settles at the fully-drained value rather
    // than snapshotting mid-race.
    const fromWireFee = WIREClient.splitWireFee(SwapAmounts.SourceWireUnits)
    const expectedCustody =
      reservCustodyBefore + SwapAmounts.SourceWireUnits - fromWireFee.fee
    await pollUntil(
      "rewards bucket drained from sysio.reserv custody",
      async () =>
        (await context.wireClient.getWireBalance("sysio.reserv")) === expectedCustody,
      Timing.DrainDeadlineMs,
      Timing.LongPollIntervalMs
    )
    expect(await context.wireClient.getWireBalance("sysio.reserv")).toBe(expectedCustody)

    // Challenge window: the target-leg lock persists after delivery.
    const row = await fromWireUwreq()
    expect(await locksForUwreq(Number(row.id))).toHaveLength(1)
  })
})
