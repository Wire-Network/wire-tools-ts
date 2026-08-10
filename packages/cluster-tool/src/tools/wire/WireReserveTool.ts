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
   * Reward share of the WIRE-leg fee, in basis points (the remainder routes to
   * the emissions treasury). Mirrors `sysio.reserv::FEE_REWARD_SHARE_BPS`
   * (5000 = a 50/50 reward/emissions split). The reward share is retained in
   * `sysio.reserv` custody as a rewards bucket; only the emissions share leaves
   * custody — so it is the half that shifts a flow's custody-balance assertion.
   */
  export const FeeRewardShareBps = 5_000

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
   * `rewardShare + emissionsShare === fee` and `net + fee === wireAmount`,
   * with no rounding leak.
   */
  export interface WireFee {
    /** Total fee charged on the WIRE leg. */
    fee: bigint
    /** Portion accrued to the rewards bucket — stays in `sysio.reserv` custody. */
    rewardShare: bigint
    /** Portion returned to the emissions treasury — leaves `sysio.reserv` custody. */
    emissionsShare: bigint
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
   * Sum of the two pool-side weights, in basis points — the TypeScript mirror
   * of `sysio::opp::amm::WEIGHT_TOTAL_BPS`. A reserve's `connector_weight_bps`
   * is the WIRE-side weight; the token side gets the remainder.
   */
  export const WeightTotalBps = 10_000

  /**
   * The `connector_weight_bps` at which a reserve is symmetric (50/50). At this
   * weight {@link outGivenIn} reduces to pure constant product and takes the
   * EXACT integer path — no fixed-point error.
   */
  export const SymmetricConnectorWeightBps = 5_000

  /** Fractional bits for the log2/exp2 fixed-point internals (Q60). */
  const FpBits = 60n
  /** `1.0` in Q60. */
  const FpOne = 1n << FpBits

  /**
   * `2^(2^-i)` in Q60 for i = 1..60 — the table {@link exp2Frac} multiplies
   * through to build `2^f` from the binary fraction of `f`. Copied verbatim
   * from `sysio::opp::amm::EXP2_FRAC_TBL`; the two must stay bit-identical or
   * quotes and settlement diverge.
   */
  const Exp2FracTable: readonly bigint[] = [
    0x16a09e667f3bcc91n, 0x1306fe0a31b7152en,
    0x1172b83c7d517addn, 0x10b5586cf9890f63n,
    0x1059b0d31585743bn, 0x102c9a3e778060een,
    0x10163da9fb33356en, 0x100b1afa5abcbed6n,
    0x10058c86da1c09ean, 0x1002c605e2e8cec5n,
    0x100162f3904051fan, 0x1000b175effdc76cn,
    0x100058ba01fb9f97n, 0x10002c5cc37da949n,
    0x1000162e525ee054n, 0x10000b17255775c0n,
    0x1000058b91b5bc9bn, 0x100002c5c89d5ec7n,
    0x10000162e43f4f83n, 0x100000b1721bcfcan,
    0x10000058b90cf1e7n, 0x1000002c5c863b74n,
    0x100000162e430e5an, 0x1000000b17218355n,
    0x100000058b90c0b5n, 0x10000002c5c8601dn,
    0x1000000162e42fffn, 0x10000000b17217fcn,
    0x1000000058b90bfdn, 0x100000002c5c85fen,
    0x10000000162e42ffn, 0x100000000b172180n,
    0x10000000058b90c0n, 0x1000000002c5c860n,
    0x100000000162e430n, 0x1000000000b17218n,
    0x100000000058b90cn, 0x10000000002c5c86n,
    0x1000000000162e43n, 0x10000000000b1721n,
    0x1000000000058b91n, 0x100000000002c5c8n,
    0x10000000000162e4n, 0x100000000000b172n,
    0x10000000000058b9n, 0x1000000000002c5dn,
    0x100000000000162en, 0x1000000000000b17n,
    0x100000000000058cn, 0x10000000000002c6n,
    0x1000000000000163n, 0x10000000000000b1n,
    0x1000000000000059n, 0x100000000000002cn,
    0x1000000000000016n, 0x100000000000000bn,
    0x1000000000000006n, 0x1000000000000003n,
    0x1000000000000001n, 0x1000000000000001n
  ]

  /**
   * `log2(x)` for a Q60 value `>= FpOne` (real `x >= 1`), returned in Q60.
   * Bit-by-bit mantissa squaring — the mirror of `amm::log2_fp`.
   */
  function log2Fp(xFp: bigint): bigint {
    let x = xFp,
      result = 0n
    // Integer part: bring the mantissa into [FpOne, 2*FpOne).
    while (x >= FpOne << 1n) {
      x >>= 1n
      result += FpOne
    }
    // Fractional part: square repeatedly; each carry past 2 contributes a bit.
    let b = FpOne >> 1n
    for (let i = 0n; i < FpBits; i++) {
      x = (x * x) >> FpBits
      if (x >= FpOne << 1n) {
        result += b
        x >>= 1n
      }
      b >>= 1n
    }
    return result
  }

  /**
   * `2^f` for `f` in `[0, FpOne)`, returned in Q60 within `[FpOne, 2*FpOne)`.
   * The mirror of `amm::exp2_frac`.
   */
  function exp2Frac(fraction: bigint): bigint {
    let f = fraction,
      y = FpOne
    for (let i = 0; i < Number(FpBits); i++) {
      f <<= 1n
      if (f >= FpOne) {
        f -= FpOne
        y = (y * Exp2FracTable[i]) >> FpBits
      }
    }
    return y
  }

  /**
   * `(num/den)^(expNum/expDen)` for a base in `(0,1]` and a positive exponent,
   * returned in Q60 within `(0, FpOne]`. The mirror of `amm::pow_frac_fp`,
   * evaluated as `2^(-e * log2(den/num))`.
   */
  function powFracFp(
    num: bigint,
    den: bigint,
    expNum: bigint,
    expDen: bigint
  ): bigint {
    if (expDen === 0n) return FpOne
    // base >= 1 -> 1 (only base == 1 reaches here).
    if (num >= den) return FpOne

    const xFp = (den << FpBits) / num,
      lr = log2Fp(xFp),
      g = (lr * expNum) / expDen,
      gi = g >> FpBits
    // 2^(-g) below 1 ULP -> 0.
    if (gi >= FpBits + 2n) return 0n
    const gf = g - (gi << FpBits),
      e2 = exp2Frac(gf),
      inv = (FpOne * FpOne) / e2
    return inv >> gi
  }

  /**
   * Weighted constant-product output — the TypeScript mirror of
   * `sysio::opp::amm::out_given_in`, the curve the depot actually settles on:
   *
   * ```
   * amountOut = balanceOut * (1 - (balanceIn/(balanceIn+amountIn))^(wIn/wOut))
   * ```
   *
   * Equal weights take the EXACT integer constant-product path
   * ({@link cpOutput}); unequal weights evaluate the fractional power in Q60
   * fixed point, with the subtracted term rounded UP so the output is floored —
   * the reserve never over-pays. Both branches are bit-identical to the
   * contract.
   *
   * @param balanceIn - The input side's pool depth.
   * @param weightIn - The input side's weight in bps.
   * @param balanceOut - The output side's pool depth.
   * @param weightOut - The output side's weight in bps.
   * @param amountIn - The amount entering the input side.
   * @returns `floor(amountOut)`, capped at `balanceOut`, or `0n` on degenerate
   *   input.
   */
  export function outGivenIn(
    balanceIn: bigint,
    weightIn: bigint,
    balanceOut: bigint,
    weightOut: bigint,
    amountIn: bigint
  ): bigint {
    if (balanceIn <= 0n || balanceOut <= 0n || amountIn <= 0n) return 0n
    if (weightIn <= 0n || weightOut <= 0n) return 0n

    // Symmetric pool: pure constant product, exact integer arithmetic.
    if (weightIn === weightOut) {
      const out = cpOutput(balanceIn, balanceOut, amountIn)
      return out >= balanceOut ? balanceOut : out
    }

    const bpow = powFracFp(balanceIn, balanceIn + amountIn, weightIn, weightOut),
      // Round the subtracted term UP so `out` is floored.
      term = (balanceOut * bpow + (FpOne - 1n)) >> FpBits
    return term >= balanceOut ? 0n : balanceOut - term
  }

  /**
   * Quote a reserve's TOKEN side into WIRE — the mirror of
   * `sysio::opp::amm::token_to_wire`. This is the source-side hop of a swap.
   *
   * @param reserveChainAmount - The reserve's token-side depth.
   * @param reserveWireAmount - The reserve's WIRE-side depth.
   * @param connectorWeightBps - The reserve's WIRE-side weight in bps.
   * @param amountToken - The token amount entering the reserve.
   * @returns The gross WIRE the curve yields (pre-fee).
   */
  export function tokenToWire(
    reserveChainAmount: bigint,
    reserveWireAmount: bigint,
    connectorWeightBps: number,
    amountToken: bigint
  ): bigint {
    const cw = BigInt(connectorWeightBps)
    return outGivenIn(
      reserveChainAmount,
      BigInt(WeightTotalBps) - cw,
      reserveWireAmount,
      cw,
      amountToken
    )
  }

  /**
   * Quote a reserve's WIRE side into its TOKEN — the mirror of
   * `sysio::opp::amm::wire_to_token`. This is the destination-side hop of a
   * swap, and consumes the POST-fee WIRE leg.
   *
   * @param reserveWireAmount - The reserve's WIRE-side depth.
   * @param reserveChainAmount - The reserve's token-side depth.
   * @param connectorWeightBps - The reserve's WIRE-side weight in bps.
   * @param amountWire - The WIRE amount entering the reserve.
   * @returns The token amount the curve yields.
   */
  export function wireToToken(
    reserveWireAmount: bigint,
    reserveChainAmount: bigint,
    connectorWeightBps: number,
    amountWire: bigint
  ): bigint {
    const cw = BigInt(connectorWeightBps)
    return outGivenIn(
      reserveWireAmount,
      cw,
      reserveChainAmount,
      BigInt(WeightTotalBps) - cw,
      amountWire
    )
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
   * @param rewardShareBps - Reward share of the fee in bps (defaults to
   *   {@link FeeRewardShareBps}).
   * @returns The {@link WireFee} decomposition.
   */
  export function splitWireFee(
    wireAmount: bigint,
    feeBps: number,
    rewardShareBps: number = FeeRewardShareBps
  ): WireFee {
    const bps = BigInt(BpsTotal),
      clampedFeeBps = BigInt(Math.min(Math.max(feeBps, 0), BpsTotal)),
      clampedRewardBps = BigInt(
        Math.min(Math.max(rewardShareBps, 0), BpsTotal)
      ),
      fee = (wireAmount * clampedFeeBps) / bps,
      rewardShare = (fee * clampedRewardBps) / bps
    return {
      fee,
      rewardShare,
      emissionsShare: fee - rewardShare,
      net: wireAmount - fee
    }
  }

  /** One reserve row's `(chain, wire)` book and its curve weight. */
  export interface ReserveBook {
    /** The reserve's chain-side (token) depth. */
    chain: bigint
    /** The reserve's WIRE-side depth. */
    wire: bigint
    /**
     * The reserve's `connector_weight_bps` — its WIRE-side weight, the token
     * side taking the remainder of {@link WeightTotalBps}. Required rather
     * than defaulted: a book quoted at the wrong weight rides a different
     * curve than the depot settles on, and at
     * {@link SymmetricConnectorWeightBps} (the common case) the error is
     * invisible, so a default would hide the mistake exactly where it is
     * hardest to notice.
     */
    connectorWeightBps: number
  }

  /**
   * Post-fee swap quote along the depot curve — the TypeScript mirror of
   * `sysio::opp::amm::quote_swap`, evaluated over book values the caller
   * already holds. Pass `null` for a WIRE endpoint: the depot IS the WIRE side,
   * so that leg consults no reserve.
   *
   * The WIRE-leg fee is charged BETWEEN the hops — the source side gives up the
   * full gross intermediate, and only the post-fee remainder converts into the
   * destination token. Quoting the hops fee-free overstates the destination
   * amount by roughly `feeBps`, which is what the depot settles short of: since
   * `sysio.uwrit` derives `dst_amount` from this same expression, a fee-free
   * quote is not a settlement amount, it is a settlement amount plus the fee.
   *
   * @param source - The source reserve's book, or `null` for a WIRE source.
   * @param destination - The destination reserve's book, or `null` for a WIRE
   *   destination.
   * @param amountIn - The source amount in the source leg's depot-frame units.
   * @param feeBps - The WIRE-leg fee in basis points — pass the live
   *   `uwconfig.fee_bps` ({@link readFeeBps}).
   * @returns The destination amount the recipient receives, or `0n` when the
   *   input or either hop is degenerate — the on-chain "no quote available"
   *   convention.
   */
  export function quoteSwap(
    source: ReserveBook | null,
    destination: ReserveBook | null,
    amountIn: bigint,
    feeBps: number
  ): bigint {
    if (amountIn <= 0n) return 0n
    // WIRE → WIRE is a plain transfer: no curve, no fee.
    if (source == null && destination == null) return amountIn
    const wireLeg =
      source == null
        ? amountIn
        : tokenToWire(
            source.chain,
            source.wire,
            source.connectorWeightBps,
            amountIn
          )
    if (wireLeg === 0n) return 0n
    const { net } = splitWireFee(wireLeg, feeBps)
    // A WIRE destination receives the post-fee WIRE leg directly.
    if (destination == null) return net
    return wireToToken(
      destination.wire,
      destination.chain,
      destination.connectorWeightBps,
      net
    )
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
  export function toDepot(
    nativeAmount: bigint,
    nativeDecimals: number
  ): bigint {
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
  export function fromDepot(
    depotAmount: bigint,
    nativeDecimals: number
  ): bigint {
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
    return (
      triple.chainCode === WireChainCode && triple.tokenCode === WireTokenCode
    )
  }

  /**
   * Cross-chain swap quote — the read-only `sysio.reserv::swapquote` surface,
   * evaluated client-side from the live `reserves` table and the live
   * `uwconfig.fee_bps` (reads). A thin composition of {@link quoteSwap} over
   * those rows, so callers can assert expected quotes before issuing a
   * SWAP_REQUEST and get the amount the depot will actually settle.
   *
   * The fee is read here rather than accepted as a parameter: `sysio.uwrit`
   * reads `uwconfig.fee_bps` fresh at both ingestion and settlement, and a
   * caller who forgets to apply it gets a quote that is short by exactly the
   * fee — silently, since a loose variance tolerance still admits the request.
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
    const bookFor = (triple: ReserveTriple): ReserveBook | undefined => {
      const reserve = rows.find(
        row =>
          slugValue(row.chain_code) === triple.chainCode &&
          slugValue(row.token_code) === triple.tokenCode &&
          slugValue(row.reserve_code) === triple.reserveCode
      )
      return reserve == null
        ? undefined
        : {
            chain: BigInt(reserve.reserve_chain_amount),
            wire: BigInt(reserve.reserve_wire_amount),
            connectorWeightBps: Number(reserve.connector_weight_bps)
          }
    }

    // `null` denotes the WIRE leg (no reserve consulted); a missing row for a
    // non-WIRE leg is "no quote available".
    let source: ReserveBook | null = null
    if (!fromIsWire) {
      const book = bookFor(from)
      if (book == null) return 0n
      source = book
    }
    let destination: ReserveBook | null = null
    if (!toIsWire) {
      const book = bookFor(to)
      if (book == null) return 0n
      destination = book
    }
    return quoteSwap(source, destination, fromAmount, await readFeeBps(wire))
  }
}
