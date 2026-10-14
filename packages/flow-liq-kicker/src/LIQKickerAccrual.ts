import { SysioContracts } from "@wireio/sdk-core"

/**
 * The flow's independent model of `sysio.kicker`'s gift and `sysio.liq`'s yield
 * index — the values a kick must produce, computed from the state it read. Integer
 * (bigint) arithmetic, floored exactly where the contracts floor:
 *
 * - `kicker_math::interest`: `floor(supply × rate_bps × elapsed_us / (10000 × 31,557,600 × 10^6))`
 *   (one Julian year of 365.25 days);
 * - `opp::twap::price_fp`: the pool's spot ratio as Q64.64, `floor((wire << 64) / shadow)`;
 * - `opp::twap::average_price`: the cumulative-price delta divided by elapsed microseconds;
 * - `kicker_math::spot_deviates`: `|spot - twap| × 10000 > twap × max_spot_deviation_bps`;
 * - `kicker_math::gift_at_price`: `floor(interest × price / 2^64)` — wire-sysio's
 *   `kicker_test_reference.hpp` oracle, which the contract's own tests check it against;
 * - `sysio.liq::distribute`: `index += (gift × 10^12 + carry) / supply`, the remainder
 *   becomes the new carry and the pot grows by the gift.
 */
export namespace LIQKickerAccrual {
  /** `kicker_math::bps_scale` — rates are basis points. */
  export const BpsScale = 10_000n
  /** `kicker_math::year_sec` — one Julian year (365.25 days), in seconds. */
  export const JulianYearSec = 31_557_600n
  /** `kicker_math::micros_per_sec` — `time_point` resolution. */
  export const MicrosPerSecond = 1_000_000n
  /** `opp::twap::PRICE_FRACTION_BITS` — the Q64.64 spot price's fraction width. */
  export const PriceFractionBits = 64n
  /** `opp::shadow::YIELD_INDEX_SCALE` — `owed = balance × Δindex / scale`. */
  export const YieldIndexScale = 1_000_000_000_000n

  /** Maximum payable catch-up: 72 hours, independent of the TWAP window. */
  export const MaxCatchupMicros = 72n * 3_600n * MicrosPerSecond
  /** Width of each cumulative-price limb. */
  const LimbBits = 128n
  /** Modulus of swap's cumulative-price arithmetic: `opp::twap::accumulate` wraps at 2^256. */
  export const CumulativeModulus = 1n << (2n * LimbBits)

  /** Decode the generated two-limb cumulative price. */
  export function cumulative(
    price: SysioContracts.SysioKickerCumulativePriceType
  ): bigint {
    return (BigInt(price.hi) << LimbBits) + BigInt(price.lo)
  }

  /**
   * Average a cumulative-price delta, modulo 2^256, as the contract does.
   * @param before - Observation snapshot at the start of the window.
   * @param after - Cumulative price at the kick block.
   * @param elapsedMicros - Observation-window duration.
   * @returns Floored Q64.64 TWAP (zero for an invalid window).
   */
  export function twap(before: bigint, after: bigint, elapsedMicros: bigint): bigint {
    if (elapsedMicros <= 0n) return 0n
    const delta = (after - before + CumulativeModulus) % CumulativeModulus
    return delta >> LimbBits >= elapsedMicros ? 0n : delta / elapsedMicros
  }

  /** The divisor of {@link interest}: bps scale × Julian year × microseconds. */
  const AccrualDivisor = BpsScale * JulianYearSec * MicrosPerSecond

  /**
   * Simple accrual on `supply` at `rateBps` over `elapsedMicros`, in shadow base units.
   *
   * @param supply - The LIQ token's `stat.supply` (base units).
   * @param rateBps - The pool's annual rate in basis points.
   * @param elapsedMicros - Microseconds since the pool's `last_kick`.
   * @returns The floored interest.
   */
  export function interest(
    supply: bigint,
    rateBps: bigint,
    elapsedMicros: bigint
  ): bigint {
    return (supply * rateBps * elapsedMicros) / AccrualDivisor
  }

  /**
   * The pool's spot ratio as Q64.64 — WIRE per shadow unit, floored.
   *
   * @param poolWire - The LIQ/WIRE pair's WIRE reserve (base units).
   * @param poolShadow - The pair's shadow reserve (base units); must be nonnegative.
   * @returns `floor((poolWire << 64) / poolShadow)`, or zero for an empty shadow reserve.
   */
  export function priceFixedPoint(poolWire: bigint, poolShadow: bigint): bigint {
    if (poolShadow < 0n || poolWire < 0n) {
      throw new Error("LIQKickerAccrual: reserves must be nonnegative")
    }
    if (poolShadow === 0n) return 0n
    return (poolWire << PriceFractionBits) / poolShadow
  }

  /**
   * `kicker_math::spot_deviates`: whether the pool's spot strays from the window TWAP
   * by more than `maxDeviationBps` of the TWAP, `|spot - twap| × 10000 > twap × maxDeviationBps`.
   * A kick that sees this pays nothing and sets the pool's `spot_deviation`.
   *
   * @param spot - The pair's Q64.64 spot ratio at the kick ({@link priceFixedPoint}).
   * @param twap - The Q64.64 TWAP over the pool's observation window ({@link twap}).
   * @param maxDeviationBps - `kickcfg.max_spot_deviation_bps`.
   * @returns False at the threshold itself; true for a zero TWAP against any nonzero spot.
   */
  export function spotDeviates(spot: bigint, twap: bigint, maxDeviationBps: bigint): boolean {
    const deviation = spot > twap ? spot - twap : twap - spot
    return deviation * BpsScale > twap * maxDeviationBps
  }

  /** The inputs of one kick's gift. */
  export interface GiftInput {
    /** The LIQ token's supply at the kick (base units). */
    readonly supply: bigint
    /** The pool's annual rate (bps). */
    readonly rateBps: bigint
    /** Microseconds the kick pays for (`now - last_kick`). */
    readonly elapsedMicros: bigint
    /** The contract's Q64.64 TWAP over the pool's observation interval. */
    readonly price: bigint
  }

  /**
   * The WIRE a kick pays when it pays in full: the interest priced at the observed TWAP.
   *
   * @param input - Supply, rate, elapsed time and observed TWAP.
   * @returns The gift in WIRE base units.
   */
  export function gift(input: GiftInput): bigint {
    const { supply, rateBps, elapsedMicros, price } = input
    return (
      (interest(
        supply,
        rateBps,
        elapsedMicros > MaxCatchupMicros ? MaxCatchupMicros : elapsedMicros
      ) *
        price) >>
      PriceFractionBits
    )
  }

  /**
   * The yield index after `sysio.liq::distribute` spreads `amount` WIRE over `supply`.
   *
   * @param before - The shadow's `yieldidx` row before the distribution.
   * @param amount - The WIRE distributed (base units).
   * @param supply - The shadow's supply (base units); must be positive.
   * @returns The index, pot and carry after the distribution.
   */
  export function distribute(
    before: SysioContracts.SysioLiqYieldIndexType,
    amount: bigint,
    supply: bigint
  ): SysioContracts.SysioLiqYieldIndexType {
    if (supply <= 0n) {
      throw new Error(`LIQKickerAccrual: supply ${supply} must be positive`)
    }
    const total = amount * YieldIndexScale + BigInt(before.carry)
    return {
      index: (BigInt(before.index) + total / supply).toString(),
      pot: (BigInt(before.pot) + amount).toString(),
      carry: (total % supply).toString()
    }
  }
}
