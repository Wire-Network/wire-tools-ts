import "jest"
import * as anchor from "@coral-xyz/anchor"
import { Connection, PublicKey } from "@solana/web3.js"
import { ethers } from "ethers"
import {
  FlowTestContext,
  log,
  matchesProtoEnum,
  pollUntil,
  ProcessManager,
  ensureSwapUserIdentities,
  requestEthereumSwap,
  requestSolanaSwap,
  SwapUserIdentities,
  SOLClient,
  underwriterAccountName,
  WIREClient
} from "@wireio/test-cluster-tool"
import { UnderwriteRequestStatus } from "@wireio/opp-typescript-models"
import { SlugName, SystemContracts } from "@wireio/sdk-core"
import * as Fs from "node:fs"
import * as Path from "node:path"
import { Timing, Reserves, SwapAmounts, Variance } from "./constants.js"

/**
 * Flow: SWAP_REQUEST → underwriter race → SWAP_REMIT (bidirectional
 * Ethereum ↔ Solana) — end-to-end through real outposts.
 *
 * Phase A — Ethereum → Solana. User calls
 * `ReserveManager.requestSwap` with native ETH; batch operators relay
 * the SWAP_REQUEST envelope to the depot; underwriter daemons commit
 * on both outposts; depot resolves the race + debits SOL reserve +
 * emits SWAP_REMIT; SOL outpost's `handle_swap_remit` drains lamports
 * from the Reserve PDA to the user's SOL address.
 *
 * Phase B — Solana → Ethereum. Same flow inverted via SOL outpost's
 * `request_swap` IX. ETH outpost's existing `_handleSwapRemit` settles
 * ETH to the user's address.
 *
 * The canonical proof in each direction is the **destination user
 * balance bump** — which only happens if every protocol surface (six
 * surfaces per direction, twelve total) is working end-to-end.
 */

describe("Flow: SWAP with underwriting (bidirectional Ethereum ↔ Solana)", () => {
  let context: FlowTestContext
  let users: SwapUserIdentities
  let reserveManager: ethers.Contract
  let oppProgram: anchor.Program<anchor.Idl>
  let solanaConnection: Connection

  const slugValueOf = (v: unknown): number =>
    typeof v === "object" && v !== null && "value" in v
      ? Number((v as { value: unknown }).value)
      : Number(v)

  /** Read one reserve row's (chain, wire) book by its slug triple. */
  async function reserveBook(
    chainCode: number, tokenCode: number, reserveCode: number
  ): Promise<{ chain: bigint; wire: bigint }> {
    const { rows } = await context.wireClient.getTableRows<any>({
      code: "sysio.reserv", scope: "sysio.reserv", table: "reserves"
    })
    const row = rows.find((r: any) =>
      slugValueOf(r.chain_code) === chainCode &&
      slugValueOf(r.token_code) === tokenCode &&
      slugValueOf(r.reserve_code) === reserveCode
    )
    expect(row).toBeDefined()
    return {
      chain: BigInt(row.reserve_chain_amount),
      wire: BigInt(row.reserve_wire_amount)
    }
  }

  async function locksForUwreq(uwreqId: number): Promise<any[]> {
    const { rows } = await context.wireClient.getTableRows<any>({
      code: "sysio.uwrit", scope: "sysio.uwrit", table: "locks"
    })
    return rows.filter((l: any) => Number(l.uwreq_id) === uwreqId)
  }

  beforeAll(async () => {
    // `reqUwCollat`: the depot's `meets_role_min` rejects non-bootstrapped
    // underwriters when the config is empty (matches the gate flow-c needs
    // — uwrit.a must flip ACTIVE for the underwriter race to land any
    // commits). The bootstrap deposit lands `min_bond` on both chains
    // (per `UnderwriterTools.depositMinBond` = 1_000_000), so configuring
    // the requirement at the same threshold lets `reevaluate_eligibility`
    // call `processuw` to set status=ACTIVE inline on the second deposit
    // round-trip.
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

    // Bind the ETH-side ReserveManager to the user wallet so requestSwap
    // signs as the user (not as an operator).
    const ethAddrs = context.loadETHAddresses()
    reserveManager = context.loadETHContract("ReserveManager", ethAddrs.ReserveManager)
      .connect(users.ethereumWallet) as ethers.Contract

    // Load the deployed opp-outpost program for the Solana side.
    const solanaPath = context.solanaPath
    if (!solanaPath) {
      throw new Error("flow-swap-with-underwriting requires WIRE_SOLANA_PATH")
    }
    const idlPath = Path.join(solanaPath, "target", "idl", "opp_outpost.json")
    const idl = JSON.parse(Fs.readFileSync(idlPath, "utf-8")) as anchor.Idl
    solanaConnection = new Connection(
      `http://127.0.0.1:${context.ports.solanaRpc}`,
      "confirmed"
    )
    const provider = new anchor.AnchorProvider(
      solanaConnection,
      new anchor.Wallet(users.solanaKeypair),
      { commitment: "confirmed" }
    )
    oppProgram = new anchor.Program(idl, provider)
  }, Timing.BootstrapTimeoutMs)

  afterAll(async () => {
    try {
      await context?.teardown()
    } catch (err) {
      log.error("Error during teardown:", err)
    }
    await ProcessManager.get().killAll()
  }, 30_000)

  // ── Phase 0: chain health + bootstrap-seeded reserves ──────────────────

  test("WIRE chain is producing blocks", async () => {
    const info = await context.wireClient.getInfo()
    expect(Number(info.head_block_num)).toBeGreaterThan(0)
  })

  test("bootstrap seeded ETHEREUM/ETH/PRIMARY + SOLANA/SOL/PRIMARY reserves ACTIVE", async () => {
    const { rows } = await context.wireClient.getTableRows<any>({
      code: "sysio.reserv",
      scope: "sysio.reserv",
      table: "reserves"
    })
    const slugValue = (v: unknown): number =>
      typeof v === "object" && v !== null && "value" in v
        ? Number((v as { value: unknown }).value)
        : Number(v)

    const ethReserve = rows.find((row: any) =>
      slugValue(row.chain_code) === Reserves.Ethereum.ETH.ChainCode &&
      slugValue(row.token_code) === Reserves.Ethereum.ETH.TokenCode &&
      slugValue(row.reserve_code) === Reserves.Ethereum.ETH.ReserveCode
    )
    expect(ethReserve).toBeDefined()

    const solReserve = rows.find((row: any) =>
      slugValue(row.chain_code) === Reserves.Solana.SOL.ChainCode &&
      slugValue(row.token_code) === Reserves.Solana.SOL.TokenCode &&
      slugValue(row.reserve_code) === Reserves.Solana.SOL.ReserveCode
    )
    expect(solReserve).toBeDefined()
  })

  // The harness bootstrap deposits underwriter collateral on both
  // outposts ([Phase 11d]), but the OPP relay round-trip needs to
  // complete (DEPOSIT_REQUEST → depositinle on the depot side) before
  // uwrit.a flips to ACTIVE. Without ACTIVE underwriter, no commits land
  // for SWAP_REQUEST and the race never resolves.
  test("uwrit.a becomes ACTIVE (deposits credit)", async () => {
    await pollUntil(
      "uwrit.a ACTIVE",
      async () => {
        const { rows } = await context.wireClient.getTableRows<any>({
          code: "sysio.opreg", scope: "sysio.opreg", table: "operators"
        })
        const uw = rows.find((r: any) => r.account === underwriterAccountName(0))
        if (!uw) return false
        return matchesProtoEnum(
          uw.status,
          SystemContracts.SysioOpregOperatorstatus,
          SystemContracts.SysioOpregOperatorstatus.OPERATOR_STATUS_ACTIVE
        )
      },
      Timing.UwreqDeadlineMs,
      Timing.LongPollIntervalMs
    )
  }, Timing.UwreqDeadlineMs + 30_000)

  // ── Phase A: Ethereum → Solana ────────────────────────────────────────

  describe("Phase A: Ethereum → Solana", () => {
    let solanaBalanceBefore: number
    let phaseATargetAmount: bigint

    test("compute swapquote for Ethereum → Solana", async () => {
      // Reserves are seeded with a 1:1 chain_amount:wire_amount ratio
      // (10B base units each side per Phase 16c). Quote at ~5% draw
      // returns roughly the source amount minus slippage.
      // Scale source wei (1e18) → reserveSeedAmount units (1e9 scale)
      // by /1e9 so the cp_output math operates on the same magnitude
      // as the reserve. The depot would do this internally on a real
      // SwapRequest but `swapquote` here is plain arithmetic.
      const quote = await context.wireClient.swapquote(
        Reserves.Ethereum.ETH.ChainCode,
        Reserves.Ethereum.ETH.TokenCode,
        Reserves.Ethereum.ETH.ReserveCode,
        Number(SwapAmounts.PhaseA.SourceEthereumWei / 10n ** 9n),
        Reserves.Solana.SOL.ChainCode,
        Reserves.Solana.SOL.TokenCode,
        Reserves.Solana.SOL.ReserveCode
      )
      expect(quote).toBeGreaterThan(0)
      // Convert quote back to lamport scale (1e9) for the SwapRequest payload.
      phaseATargetAmount = BigInt(quote)
      log.info(`[PhaseA] swapquote = ${quote} → targetAmount = ${phaseATargetAmount}`)
    })

    let booksBefore: {
      src: { chain: bigint; wire: bigint }
      dst: { chain: bigint; wire: bigint }
    }

    test("user calls ReserveManager.requestSwap (50 ETH → SOL)", async () => {
      booksBefore = {
        src: await reserveBook(
          Reserves.Ethereum.ETH.ChainCode,
          Reserves.Ethereum.ETH.TokenCode,
          Reserves.Ethereum.ETH.ReserveCode
        ),
        dst: await reserveBook(
          Reserves.Solana.SOL.ChainCode,
          Reserves.Solana.SOL.TokenCode,
          Reserves.Solana.SOL.ReserveCode
        )
      }
      solanaBalanceBefore = await solanaConnection.getBalance(users.solanaKeypair.publicKey)
      const result = await requestEthereumSwap(reserveManager as any, {
        sourceTokenCode:    BigInt(Reserves.Ethereum.ETH.TokenCode),
        sourceReserveCode:  BigInt(Reserves.Ethereum.ETH.ReserveCode),
        sourceAmountWei:    SwapAmounts.PhaseA.SourceEthereumWei,
        targetChainCode:    BigInt(Reserves.Solana.SOL.ChainCode),
        targetTokenCode:    BigInt(Reserves.Solana.SOL.TokenCode),
        targetReserveCode:  BigInt(Reserves.Solana.SOL.ReserveCode),
        targetRecipient:    users.solanaPublicKeyBytes,
        targetAmount:       phaseATargetAmount,
        targetToleranceBps: Variance.ToleranceBps
      })
      expect(result.transactionHash).toBeTruthy()
    })

    test("depot creates PENDING UWREQ row", async () => {
      await pollUntil(
        "PhaseA UWREQ row appears",
        async () => {
          const { rows } = await context.wireClient.getTableRows<any>({
            code: "sysio.uwrit", scope: "sysio.uwrit", table: "uwreqs"
          })
          const slugValue = (v: unknown): number =>
            typeof v === "object" && v !== null && "value" in v
              ? Number((v as { value: unknown }).value) : Number(v)
          return rows.some((r: any) =>
            slugValue(r.src_chain_code) === Reserves.Ethereum.ETH.ChainCode &&
            slugValue(r.dst_chain_code) === Reserves.Solana.SOL.ChainCode
          )
        },
        Timing.UwreqDeadlineMs,
        Timing.LongPollIntervalMs
      )
    }, Timing.UwreqDeadlineMs + 30_000)

    test("UWREQ transitions to CONFIRMED with a winning underwriter", async () => {
      await pollUntil(
        "PhaseA UWREQ status=CONFIRMED",
        async () => {
          const { rows } = await context.wireClient.getTableRows<any>({
            code: "sysio.uwrit", scope: "sysio.uwrit", table: "uwreqs"
          })
          const slugValue = (v: unknown): number =>
            typeof v === "object" && v !== null && "value" in v
              ? Number((v as { value: unknown }).value) : Number(v)
          const row = rows.find((r: any) =>
            slugValue(r.src_chain_code) === Reserves.Ethereum.ETH.ChainCode &&
            slugValue(r.dst_chain_code) === Reserves.Solana.SOL.ChainCode
          )
          if (!row) return false
          return Number(row.status) === UnderwriteRequestStatus.CONFIRMED
              || row.status === "UNDERWRITE_REQUEST_STATUS_CONFIRMED"
        },
        Timing.RaceDeadlineMs,
        Timing.LongPollIntervalMs
      )
    }, Timing.RaceDeadlineMs + 30_000)

    test("emit-time four-sided reserve accounting + two persistent locks", async () => {
      // The reserve books move in the SAME transaction that resolves the
      // race — before the SWAP_REMIT ever leaves the depot — so they are
      // already final here, ahead of the destination payout:
      //   src: chain += src_amount, wire -= w
      //   dst: wire  += w,          chain -= dst_amount
      // with w = cp_output(src.chain, src.wire, src_amount) on the
      // pre-swap source row.
      const srcAmountDepot = SwapAmounts.PhaseA.SourceEthereumWei / 10n ** 9n
      const w = (booksBefore.src.wire * srcAmountDepot)
              / (booksBefore.src.chain + srcAmountDepot)
      // #414: the source gives up the full gross WIRE intermediate `w`, but the
      // destination receives only the post-fee net — the fee is skimmed in the
      // hop and routed to rewards (custody) + emissions (out).
      const phaseAFee = WIREClient.splitWireFee(w)

      const src = await reserveBook(
        Reserves.Ethereum.ETH.ChainCode,
        Reserves.Ethereum.ETH.TokenCode,
        Reserves.Ethereum.ETH.ReserveCode
      )
      const dst = await reserveBook(
        Reserves.Solana.SOL.ChainCode,
        Reserves.Solana.SOL.TokenCode,
        Reserves.Solana.SOL.ReserveCode
      )
      expect(src.chain).toBe(booksBefore.src.chain + srcAmountDepot)
      expect(src.wire).toBe(booksBefore.src.wire - w)
      expect(dst.wire).toBe(booksBefore.dst.wire + w - phaseAFee.fee)
      expect(dst.chain).toBe(booksBefore.dst.chain - phaseATargetAmount)

      // The w hop is internal, but #414 skims the WIRE-leg fee inside it — so
      // Σ reserve_wire_amount across the pair drops by exactly the fee (the
      // emissions half leaves custody, the rewards half moves to the bucket).
      expect(src.wire + dst.wire)
        .toBe(booksBefore.src.wire + booksBefore.dst.wire - phaseAFee.fee)

      // Both legs locked, and the locks PERSIST (wall-clock challenge
      // window — never released by delivery).
      const { rows } = await context.wireClient.getTableRows<any>({
        code: "sysio.uwrit", scope: "sysio.uwrit", table: "uwreqs"
      })
      const uwreq = rows.find((r: any) =>
        slugValueOf(r.src_chain_code) === Reserves.Ethereum.ETH.ChainCode &&
        slugValueOf(r.dst_chain_code) === Reserves.Solana.SOL.ChainCode
      )
      expect(uwreq).toBeDefined()
      expect(await locksForUwreq(Number(uwreq.id))).toHaveLength(2)
    })

    test("user's SOL balance bumps by ~targetAmount", async () => {
      await pollUntil(
        "PhaseA user receives SOL",
        async () => {
          const current = await solanaConnection.getBalance(users.solanaKeypair.publicKey)
          const drift = (phaseATargetAmount * BigInt(Variance.ToleranceBps)) / 10_000n
          const floor = solanaBalanceBefore + Number(phaseATargetAmount - drift)
          return current >= floor
        },
        Timing.RemitDeadlineMs,
        Timing.LongPollIntervalMs
      )
      const final = await solanaConnection.getBalance(users.solanaKeypair.publicKey)
      const received = BigInt(final - solanaBalanceBefore)
      log.info(`[PhaseA] user received ${received} lamports (target=${phaseATargetAmount})`)
      expect(received).toBeGreaterThan(0n)
    }, Timing.RemitDeadlineMs + 30_000)
  })

  // ── Phase B: Solana → Ethereum ────────────────────────────────────────

  describe("Phase B: Solana → Ethereum", () => {
    let ethereumBalanceBefore: bigint
    /** Depot-frame (9-decimal) target. Rides the OPP envelope. */
    let phaseBTargetAmountDepot: bigint
    /** Chain-native (18-decimal wei) target. Used in the balance assertion. */
    let phaseBTargetAmountWei: bigint

    test("compute swapquote for Solana → Ethereum", async () => {
      const quote = await context.wireClient.swapquote(
        Reserves.Solana.SOL.ChainCode,
        Reserves.Solana.SOL.TokenCode,
        Reserves.Solana.SOL.ReserveCode,
        Number(SwapAmounts.PhaseB.SourceSolanaLamports),
        Reserves.Ethereum.ETH.ChainCode,
        Reserves.Ethereum.ETH.TokenCode,
        Reserves.Ethereum.ETH.ReserveCode
      )
      expect(quote).toBeGreaterThan(0)
      // Depot frame for the envelope (9-decimal across all WIRE
      // tokens — `feedback-token-precision-9-max`). The ETH outpost
      // scales this up to wei via `PrecisionLib.fromDepot` when
      // settling the SWAP_REMIT.
      phaseBTargetAmountDepot = BigInt(quote)
      // Wei value the user expects to actually receive on Ethereum
      // (1 depot-unit = 1e9 wei, since native ETH precision = 18).
      phaseBTargetAmountWei = phaseBTargetAmountDepot * 10n ** 9n
      log.info(`[PhaseB] swapquote = ${quote} → depotUnits=${phaseBTargetAmountDepot} wei=${phaseBTargetAmountWei}`)
    })

    test("user calls opp_outpost::request_swap (SOL → ETH)", async () => {
      ethereumBalanceBefore = await context.ethProvider.getBalance(users.ethereumWallet.address)
      const sig = await requestSolanaSwap(
        solanaConnection,
        oppProgram,
        users.solanaKeypair,
        {
          sourceTokenCode:    BigInt(Reserves.Solana.SOL.TokenCode),
          sourceReserveCode:  BigInt(Reserves.Solana.SOL.ReserveCode),
          sourceAmount:       SwapAmounts.PhaseB.SourceSolanaLamports,
          targetChainCode:    BigInt(Reserves.Ethereum.ETH.ChainCode),
          targetTokenCode:    BigInt(Reserves.Ethereum.ETH.TokenCode),
          targetReserveCode:  BigInt(Reserves.Ethereum.ETH.ReserveCode),
          targetRecipient:    users.ethereumAddressBytes,
          targetAmount:       phaseBTargetAmountDepot,
          targetToleranceBps: Variance.ToleranceBps
        }
      )
      expect(sig).toBeTruthy()
    })

    test("user's ETH balance bumps by ~targetAmount", async () => {
      await pollUntil(
        "PhaseB user receives ETH",
        async () => {
          const current = await context.ethProvider.getBalance(users.ethereumWallet.address)
          const drift = (phaseBTargetAmountWei * BigInt(Variance.ToleranceBps)) / 10_000n
          return current >= ethereumBalanceBefore + (phaseBTargetAmountWei - drift)
        },
        Timing.RemitDeadlineMs,
        Timing.LongPollIntervalMs
      )
      const final = await context.ethProvider.getBalance(users.ethereumWallet.address)
      const received = final - ethereumBalanceBefore
      log.info(`[PhaseB] user received ${received} wei (targetWei=${phaseBTargetAmountWei})`)
      expect(received).toBeGreaterThan(0n)
    }, Timing.RemitDeadlineMs + 30_000)
  })
})
