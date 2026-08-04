import Assert from "node:assert"
import { SlugName, SysioContracts } from "@wireio/sdk-core"
import type { WireClient } from "../../clients/wire/WireClient.js"
import { slugValue } from "../../utils/slugUtils.js"

const { SysioContractName } = SysioContracts

/**
 * AMM / reserve math + reads for the depot's swap surface — the TypeScript
 * mirror of `sysio::opp::amm` (constant-product output, WIRE-leg fee split)
 * plus the client-side `swapquote` evaluation over the live
 * `sysio.reserv::reserves` books. Pure value helpers (called inside step
 * runners) and reads only — every swap WRITE is a Step owned by the swap
 * tools.
 */
export namespace WireReserveTool {
  /** Basis-point denominator (10000 = 100%). */
  export const BpsTotal = 10_000

  /**
   * The winning underwriter's share of the WIRE-leg fee, in basis points (the
   * remainder is the batch-operator rewards share). Mirrors
   * `sysio.reserv::FEE_UNDERWRITER_SHARE_BPS` (5000 = a 50/50 underwriter /
   * batch-operator split).
   *
   * The underwriter half stays in `sysio.reserv` custody until that account
   * calls `claimuwfee`. What happens to the rewards pool is stage 2 — see
   * {@link FeeEmissionsShareBps}.
   */
  export const FeeUnderwriterShareBps = 5_000

  /**
   * Stage 2 of the split: the share of each fee's REWARDS POOL (what stage 1
   * leaves after the underwriter's cut) transferred to the `sysio` emissions
   * treasury, in basis points. Mirrors
   * `sysio.reserv::DEFAULT_FEE_EMISSIONS_SHARE_BPS` and the live
   * `reserve_config.fee_emissions_share_bps` the bootstrap seeds.
   *
   * The default is ZERO — the whole pool accrues to the batch-operator rewards
   * bucket and NO part of a swap fee leaves custody at settlement, so a flow's
   * custody assertion sees only the swap's own transfers. A cluster configured
   * with a non-zero share moves exactly that share out at settlement time.
   */
  export const FeeEmissionsShareBps = 0

  /** The WIRE chain's slug value (the depot leg of every quote). */
  export const WireChainCode = Number(SlugName.from("WIRE"))
  /** The WIRE token's slug value. */
  export const WireTokenCode = Number(SlugName.from("WIRE"))

  /**
   * Upper bound for a single-page scan of `sysio.reserv::reserves`. The table
   * grows linearly in configured pairs — a couple hundred is enough headroom
   * for any cluster `swapquote` would target.
   */
  export const MaxReservesScan = 256

  /**
   * Decomposition of a WIRE-leg swap fee — the TypeScript mirror of
   * `sysio::opp::amm::wire_fee`. Every field is an exact integer quantity:
   * all five shares sum to `fee` and `net + fee === wireAmount`, with no
   * rounding leak.
   */
  export interface WireFee {
    /** Total fee charged on the WIRE leg. */
    fee: bigint
    /**
     * Portion accrued to the swap's winning underwriter — held in
     * `sysio.reserv` custody until that account calls `claimuwfee`.
     */
    underwriterShare: bigint
    /**
     * Portion accrued to the batch-operator rewards bucket — held in
     * `sysio.reserv` custody until `payepoch` drains it.
     */
    rewardShare: bigint
    /**
     * Portion transferred to the `sysio` emissions treasury — the ONLY part of
     * a fee that leaves `sysio.reserv` custody at settlement, and zero unless
     * the cluster configures a non-zero share.
     */
    emissionsShare: bigint
    /**
     * The SOURCE reserve owner's fee — an independent, per-reserve fee on the
     * same WIRE leg, accrued to that reserve's `owner_fee_accrued` and claimed
     * via `claimrsvfee`. Zero for a WIRE-source swap (no source reserve).
     */
    srcReserveShare: bigint
    /** The DESTINATION reserve owner's fee. Zero for a swap paying out WIRE. */
    dstReserveShare: bigint
    /** `wireAmount - fee`: the net WIRE that continues through the swap. */
    net: bigint
  }

  /**
   * Constant-product output — matches `sysio.reserv::cp_output` bit-for-bit
   * (floored integer division, uint128-safe via bigint). Returns `0n` when any
   * side is zero or negative.
   *
   * @param reserveSource - The source-side reserve depth.
   * @param reserveDestination - The destination-side reserve depth.
   * @param sourceAmount - The amount entering the source side.
   * @returns The destination amount the curve yields.
   */
  export function cpOutput(
    reserveSource: bigint,
    reserveDestination: bigint,
    sourceAmount: bigint
  ): bigint {
    if (reserveSource <= 0n || reserveDestination <= 0n || sourceAmount <= 0n)
      return 0n
    return (reserveDestination * sourceAmount) / (reserveSource + sourceAmount)
  }

  /**
   * Split a gross WIRE amount into its swap fee and remainder, mirroring
   * `sysio::opp::amm::split_wire_fee` bit-for-bit (floored integer math).
   *
   * `feeBps` is deliberately REQUIRED — the depot charges whatever the
   * `sysio.uwrit::uwconfig` singleton holds (the bootstrap seeds it via
   * `setconfig`), so callers read the live value ({@link readFeeBps}) instead
   * of relying on a hardcoded default that silently drifts from the cluster.
   *
   * @param wireAmount - The gross WIRE leg — the constant-product intermediate
   *   for a token source, or the user's escrowed WIRE for a from-WIRE swap.
   * @param feeBps - Fee in basis points — pass the live `uwconfig.fee_bps`.
   * @param underwriterShareBps - The winning underwriter's share of the fee in
   *   bps (defaults to {@link FeeUnderwriterShareBps}). Pass `0` for a path with
   *   no winning underwriter — a revert refund — which sends the whole fee into
   *   the rewards pool, exactly as `sysio.reserv::refundwire` does.
   * @param emissionsShareBps - The emissions treasury's share OF THE REWARDS
   *   POOL (not of the whole fee) in bps, mirroring the live
   *   `reserve_config.fee_emissions_share_bps`; defaults to
   *   {@link FeeEmissionsShareBps} (zero).
   * @param srcReserveFeeBps - The SOURCE reserve's `owner_fee_bps` — an
   *   independent per-reserve fee on the same leg. Zero for a WIRE source.
   * @param dstReserveFeeBps - The DESTINATION reserve's `owner_fee_bps`. Zero
   *   when the swap pays out WIRE.
   * @returns The {@link WireFee} decomposition.
   */
  export function splitWireFee(
    wireAmount: bigint,
    feeBps: number,
    underwriterShareBps: number = FeeUnderwriterShareBps,
    emissionsShareBps: number = FeeEmissionsShareBps,
    srcReserveFeeBps = 0,
    dstReserveFeeBps = 0
  ): WireFee {
    const bps = BigInt(BpsTotal),
      clamp = (value: number) => BigInt(Math.min(Math.max(value, 0), BpsTotal)),
      // Every rate applies to the SAME gross leg, so the fees are additive and
      // order-independent — matching `sysio::opp::amm::split_wire_fee`.
      srcReserveShare = (wireAmount * clamp(srcReserveFeeBps)) / bps,
      dstReserveShare = (wireAmount * clamp(dstReserveFeeBps)) / bps,
      networkFee = (wireAmount * clamp(feeBps)) / bps,
      underwriterShare = (networkFee * clamp(underwriterShareBps)) / bps,
      rewardsPool = networkFee - underwriterShare,
      emissionsShare = (rewardsPool * clamp(emissionsShareBps)) / bps,
      fee = networkFee + srcReserveShare + dstReserveShare
    return {
      fee,
      underwriterShare,
      rewardShare: rewardsPool - emissionsShare,
      emissionsShare,
      srcReserveShare,
      dstReserveShare,
      net: fee >= wireAmount ? 0n : wireAmount - fee
    }
  }

  /**
   * The drift window a swap's destination payout may deviate from its quoted
   * target — `target × toleranceBps / 10000` (floored).
   *
   * @param target - The quoted destination amount.
   * @param toleranceBps - The variance tolerance in basis points.
   * @returns The allowed absolute drift.
   */
  export function varianceDrift(target: bigint, toleranceBps: number): bigint {
    return (target * BigInt(toleranceBps)) / BigInt(BpsTotal)
  }

  /**
   * The depot-frame precision CAP. A token's depot precision is
   * `min(nativeDecimals, DepotPrecisionCap)` — a token at or below the cap
   * (6-dec stablecoins, 9-dec lamports) rides OPP envelopes at its NATIVE
   * precision (identity), and only an above-cap token (18-dec wei) scales.
   * Mirrors Ethereum `PrecisionLib.DEPOT_PRECISION` and Solana
   * `precision::DEPOT_PRECISION_DECIMALS`; changing it requires a
   * coordinated depot + outpost migration.
   */
  export const DepotPrecisionCap = 9

  /**
   * The depot-frame precision the depot records for a token —
   * `min(nativeDecimals, DepotPrecisionCap)` (mirror of Ethereum's
   * `PrecisionLib.depotPrecision`).
   *
   * @param nativeDecimals - The token's chain-native decimal scale.
   * @returns The token's depot-frame precision.
   */
  export function depotPrecision(nativeDecimals: number): number {
    Assert.ok(
      Number.isInteger(nativeDecimals) && nativeDecimals > 0,
      `WireReserveTool.depotPrecision: invalid native decimals ${nativeDecimals}`
    )
    return Math.min(nativeDecimals, DepotPrecisionCap)
  }

  /**
   * Convert a chain-native amount to the token's depot frame — the exact
   * scaling the source outpost applies before stamping an outbound
   * `SwapRequest.source_amount` (mirror of Ethereum's `PrecisionLib.toDepot`
   * and Solana's `precision::to_depot`). Per-token precision: an at-or-below-cap
   * token is identity; only an above-cap token downscales.
   *
   * @param nativeAmount - Amount in chain-native base units (wei, lamports, ERC-20 units).
   * @param nativeDecimals - The token's chain-native decimal scale.
   * @returns The amount in the token's depot-frame units (floored when downscaling).
   */
  export function toDepot(nativeAmount: bigint, nativeDecimals: number): bigint {
    const precision = depotPrecision(nativeDecimals)
    return nativeDecimals > precision
      ? nativeAmount / 10n ** BigInt(nativeDecimals - precision)
      : nativeAmount
  }

  /**
   * Convert a depot-frame amount to chain-native base units — the exact
   * scaling the destination outpost applies when paying out a remit (mirror
   * of Ethereum's `PrecisionLib.fromDepot` and Solana's `precision::from_depot`).
   * Per-token precision: an at-or-below-cap token is identity; only an
   * above-cap token upscales.
   *
   * @param depotAmount - Amount in the token's depot-frame units.
   * @param nativeDecimals - The destination token's chain-native decimal scale.
   * @returns The amount in chain-native base units.
   */
  export function fromDepot(depotAmount: bigint, nativeDecimals: number): bigint {
    const precision = depotPrecision(nativeDecimals)
    return nativeDecimals > precision
      ? depotAmount * 10n ** BigInt(nativeDecimals - precision)
      : depotAmount
  }

  /**
   * The live WIRE-leg fee (bps) from the `sysio.uwrit::uwconfig` singleton —
   * the exact value the bootstrap's `setconfig` seeded and the depot charges
   * (a read).
   *
   * @param wire - The depot client.
   * @returns The configured `fee_bps`.
   */
  export async function readFeeBps(wire: WireClient): Promise<number> {
    const { rows } = await wire
      .getSysioContract(SysioContractName.uwrit)
      .tables.uwconfig.query()
    return Number(rows[0]?.fee_bps ?? 0)
  }

  /** One reserve's identifying slug triple. */
  export interface ReserveTriple {
    /** The reserve's chain slug value. */
    chainCode: number
    /** The reserve's token slug value. */
    tokenCode: number
    /** The reserve's own slug value. */
    reserveCode: number
  }

  /** Input for {@link swapquote}. */
  export interface SwapQuoteRequest {
    /** The source leg's reserve triple (WIRE/WIRE for a from-WIRE swap). */
    from: ReserveTriple
    /** The source amount, in the source leg's depot-frame units. */
    fromAmount: bigint
    /** The destination leg's reserve triple (WIRE/WIRE for a to-WIRE swap). */
    to: ReserveTriple
  }

  /** Whether a triple denotes the WIRE leg (no reserve consulted). */
  function isWireLeg(triple: ReserveTriple): boolean {
    return triple.chainCode === WireChainCode && triple.tokenCode === WireTokenCode
  }

  /**
   * Cross-chain swap quote — the read-only `sysio.reserv::swapquote` surface,
   * evaluated client-side from the live `reserves` table (a read). Mirrors the
   * depot's `cp_output` math so callers can assert expected quotes before
   * issuing a SWAP_REQUEST.
   *
   * @param wire - The depot client.
   * @param request - The source triple + amount and destination triple.
   * @returns The destination amount, or `0n` when any required reserve row is
   *   missing — matching the on-chain "no quote available" convention.
   */
  export async function swapquote(
    wire: WireClient,
    request: SwapQuoteRequest
  ): Promise<bigint> {
    const { from, fromAmount, to } = request
    if (fromAmount <= 0n) return 0n
    const fromIsWire = isWireLeg(from),
      toIsWire = isWireLeg(to)
    if (fromIsWire && toIsWire) return fromAmount

    const { rows } = await wire
      .getSysioContract(SysioContractName.reserv)
      .tables.reserves.query({ limit: MaxReservesScan })
    const findReserve = (triple: ReserveTriple) =>
      rows.find(
        reserve =>
          slugValue(reserve.chain_code) === triple.chainCode &&
          slugValue(reserve.token_code) === triple.tokenCode &&
          slugValue(reserve.reserve_code) === triple.reserveCode
      )
    const chainAmount = (reserve: SysioContracts.SysioReservReserveRowType) =>
        BigInt(reserve.reserve_chain_amount),
      wireAmount = (reserve: SysioContracts.SysioReservReserveRowType) =>
        BigInt(reserve.reserve_wire_amount)

    if (fromIsWire) {
      const reserve = findReserve(to)
      if (reserve == null) return 0n
      return cpOutput(wireAmount(reserve), chainAmount(reserve), fromAmount)
    }
    if (toIsWire) {
      const reserve = findReserve(from)
      if (reserve == null) return 0n
      return cpOutput(chainAmount(reserve), wireAmount(reserve), fromAmount)
    }
    // Full hop: source → WIRE → destination, two reserves consulted.
    const sourceReserve = findReserve(from),
      destinationReserve = findReserve(to)
    if (sourceReserve == null || destinationReserve == null) return 0n
    const wireIntermediate = cpOutput(
      chainAmount(sourceReserve),
      wireAmount(sourceReserve),
      fromAmount
    )
    if (wireIntermediate === 0n) return 0n
    return cpOutput(
      wireAmount(destinationReserve),
      chainAmount(destinationReserve),
      wireIntermediate
    )
  }
}
