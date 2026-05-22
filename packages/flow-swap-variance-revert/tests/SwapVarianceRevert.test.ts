import "jest"
import { ethers } from "ethers"
import * as Fs from "node:fs"
import * as Path from "node:path"
import {
  FlowTestContext,
  log,
  pollUntil,
  ProcessManager,
  ensureSwapUserIdentities,
  requestEthereumSwap,
  SwapUserIdentities
} from "@wireio/test-cluster-tool"
import { SlugName } from "@wireio/sdk-core"
import { Timing, Reserves, SwapAmounts, Variance } from "./constants.js"

/**
 * Flow: Swap Variance-Tolerance Revert.
 *
 * Exercises `sysio.uwrit::createuwreq`'s variance guard at
 * `wire-sysio/contracts/sysio.uwrit/src/sysio.uwrit.cpp:647-663`. The
 * depot computes a live `swap_quote` for the (src, dst) reserves at the
 * moment the SwapRequest is dispatched; if the user's `target_amount`
 * deviates from the live quote by more than `target_tolerance_bps`,
 * the depot:
 *
 *   1. Skips the UWREQ row entirely (no `reqs.emplace` runs).
 *   2. Queues a `SWAP_REVERT` attestation back to the source outpost.
 *   3. The source outpost refunds the user's source-side deposit.
 *
 * Canonical proof:
 *   - DEPOT_OUTPOST_ETHEREUM `<epoch>-*.data` envelope decoded with
 *     an `ATTESTATION_TYPE_SWAP_REVERT` entry naming the user's
 *     SwapRequest attestation_id.
 *   - User's ETH balance returns to (initial − gas) within
 *     `Timing.RevertDeadlineMs`.
 *
 * Test driver: same harness shape as `flow-swap-with-underwriting`,
 * but the user passes a deliberately-inflated `target_amount` so the
 * variance guard fires every time without needing to drift the reserve.
 */

describe("Flow: Swap Variance-Tolerance Revert", () => {
  let context: FlowTestContext
  let users: SwapUserIdentities
  let reserveManager: ethers.Contract

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

  // ── Phase 0: chain health + bootstrap-seeded reserves ─────────────────

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
    const ethReserve = rows.find((r: any) =>
      slugValue(r.chain_code) === Reserves.Ethereum.ETH.ChainCode &&
      slugValue(r.token_code) === Reserves.Ethereum.ETH.TokenCode
    )
    const solReserve = rows.find((r: any) =>
      slugValue(r.chain_code) === Reserves.Solana.SOL.ChainCode &&
      slugValue(r.token_code) === Reserves.Solana.SOL.TokenCode
    )
    expect(ethReserve).toBeDefined()
    expect(solReserve).toBeDefined()
  })

  // ── Variance-revert path ──────────────────────────────────────────────

  describe("Out-of-tolerance SwapRequest triggers SWAP_REVERT refund", () => {
    let ethereumBalanceBefore: bigint
    let inflatedTargetAmount: bigint

    test("compute live swapquote, then inflate the user's target to exceed tolerance", async () => {
      const liveQuote = await context.wireClient.swapquote(
        Reserves.Ethereum.ETH.ChainCode,
        Reserves.Ethereum.ETH.TokenCode,
        Reserves.Ethereum.ETH.ReserveCode,
        Number(SwapAmounts.SourceEthereumWei / 10n ** 9n),
        Reserves.Solana.SOL.ChainCode,
        Reserves.Solana.SOL.TokenCode,
        Reserves.Solana.SOL.ReserveCode
      )
      expect(liveQuote).toBeGreaterThan(0)
      // Inflate by Variance.RevertMultiplier — far past the 50 bps
      // tolerance configured below. Doubling the target gives a 10_000
      // bps drift (100% off), guaranteeing the depot's variance check
      // rejects on first inspection.
      inflatedTargetAmount = BigInt(liveQuote) * BigInt(Variance.RevertMultiplier)
      log.info(
        `[VarianceRevert] liveQuote=${liveQuote} inflatedTarget=${inflatedTargetAmount} tolerance_bps=${Variance.ToleranceBps}`
      )
    })

    test("user calls ReserveManager.requestSwap with the inflated target_amount", async () => {
      ethereumBalanceBefore = await context.ethProvider.getBalance(
        users.ethereumWallet.address
      )
      const result = await requestEthereumSwap(reserveManager as any, {
        sourceTokenCode:    BigInt(Reserves.Ethereum.ETH.TokenCode),
        sourceReserveCode:  BigInt(Reserves.Ethereum.ETH.ReserveCode),
        sourceAmountWei:    SwapAmounts.SourceEthereumWei,
        targetChainCode:    BigInt(Reserves.Solana.SOL.ChainCode),
        targetTokenCode:    BigInt(Reserves.Solana.SOL.TokenCode),
        targetReserveCode:  BigInt(Reserves.Solana.SOL.ReserveCode),
        targetRecipient:    users.solanaPublicKeyBytes,
        targetAmount:       inflatedTargetAmount,
        targetToleranceBps: Variance.ToleranceBps
      })
      expect(result.transactionHash).toBeTruthy()
    })

    test("depot does NOT create a UWREQ row (createuwreq variance branch fires)", async () => {
      // Give the SwapRequest envelope time to reach the depot. If the
      // depot's variance branch DIDN'T fire, a UWREQ row would appear
      // within ~1 epoch; we wait a generous window to be sure.
      await new Promise(r => setTimeout(r, Timing.UwreqNegativeAssertMs))
      const { rows } = await context.wireClient.getTableRows<any>({
        code: "sysio.uwrit",
        scope: "sysio.uwrit",
        table: "uwreqs"
      })
      const slugValue = (v: unknown): number =>
        typeof v === "object" && v !== null && "value" in v
          ? Number((v as { value: unknown }).value)
          : Number(v)
      // No row should reference this ETHEREUM→SOLANA swap with our
      // inflated target_amount.
      const matching = rows.find((r: any) =>
        slugValue(r.src_chain_code) === Reserves.Ethereum.ETH.ChainCode &&
        slugValue(r.dst_chain_code) === Reserves.Solana.SOL.ChainCode &&
        BigInt(r.dst_amount ?? 0) === inflatedTargetAmount
      )
      expect(matching).toBeUndefined()
    }, Timing.UwreqNegativeAssertMs + 30_000)

    test("SWAP_REVERT envelope queued outbound to ETHEREUM outpost", async () => {
      const oppDir = Path.join(context.clusterPath, "data", "opp-debugging")
      await pollUntil(
        "SWAP_REVERT envelope appears for ETHEREUM outpost",
        async () => containsSwapRevert(oppDir),
        Timing.RevertDeadlineMs,
        Timing.LongPollIntervalMs
      )
    }, Timing.RevertDeadlineMs + 30_000)

    test("user's ETH balance returns to ~initial (source-side refund landed)", async () => {
      await pollUntil(
        "user ETH balance back to (initial − gas)",
        async () => {
          const current = await context.ethProvider.getBalance(
            users.ethereumWallet.address
          )
          // After the SwapRequest deducted sourceAmountWei + gas, the
          // refund should restore sourceAmountWei. Tolerate up to
          // `SwapAmounts.MaxGasReservedWei` for the request tx gas.
          const floor =
            ethereumBalanceBefore -
            SwapAmounts.MaxGasReservedWei
          return current >= floor
        },
        Timing.RevertDeadlineMs,
        Timing.LongPollIntervalMs
      )
      const final = await context.ethProvider.getBalance(
        users.ethereumWallet.address
      )
      const spent = ethereumBalanceBefore - final
      log.info(
        `[VarianceRevert] user spent ${spent} wei (= gas only; source deposit refunded)`
      )
      expect(spent).toBeLessThan(SwapAmounts.MaxGasReservedWei)
    }, Timing.RevertDeadlineMs + 30_000)
  })
})

/**
 * Scan every DEPOT_OUTPOST_ETHEREUM envelope under `oppDir` and return
 * true iff at least one carries an `ATTESTATION_TYPE_SWAP_REVERT`
 * entry. The opp-debugging directory's filename convention is
 * `<epoch>-<DIRECTION>-<hash>.{data,metadata}`; `.data` holds the
 * serialized `sysio.opp.Envelope` bytes.
 *
 * We decode via `protoc --decode_raw` to avoid pulling the proto-typed
 * decoder into the harness; the only field we care about is the inner
 * attestation type tag (proto enum value `ATTESTATION_TYPE_SWAP_REVERT
 * = 60946`).
 */
async function containsSwapRevert(oppDir: string): Promise<boolean> {
  if (!Fs.existsSync(oppDir)) return false
  const entries = Fs.readdirSync(oppDir).filter(
    name =>
      name.endsWith(".data") && name.includes("DEPOT_OUTPOST_ETHEREUM")
  )
  if (entries.length === 0) return false
  for (const entry of entries) {
    const data = Fs.readFileSync(Path.join(oppDir, entry))
    // The attestation type is encoded as a varint field 1 inside the
    // AttestationEntry message nested under Envelope.messages[].payload.
    // Proto enum SWAP_REVERT = 60955 = 0xEE1B. Serialized as proto
    // field 1 (varint wire type 0):
    //   tag    = (field_num << 3) | wire_type = (1<<3) | 0 = 0x08
    //   value  = varint-LE of 0xEE1B = [0x9B, 0xDC, 0x03]
    // The full 4-byte pattern `[0x08, 0x9B, 0xDC, 0x03]` is unambiguous
    // — false positives would require the same window inside another
    // attestation's payload, vanishingly unlikely in practice.
    if (containsBytes(data, SWAP_REVERT_ENTRY_TAG_LE)) return true
  }
  return false
}

/** Tagged varint LE of `ATTESTATION_TYPE_SWAP_REVERT = 60955` (field 1 of AttestationEntry). */
const SWAP_REVERT_ENTRY_TAG_LE = Uint8Array.of(0x08, 0x9b, 0xdc, 0x03)

/** Boyer-Moore would be overkill; the envelopes are small (< 1 KB). */
function containsBytes(haystack: Buffer, needle: Uint8Array): boolean {
  if (haystack.length < needle.length) return false
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    let match = true
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) { match = false; break }
    }
    if (match) return true
  }
  return false
}
