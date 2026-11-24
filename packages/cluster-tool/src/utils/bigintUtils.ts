/**
 * Order two bigints for `Array.prototype.sort`: negative when `left` comes first, positive
 * when `right` does, zero when equal. `left - right` cannot serve: a sort comparator must
 * return a number, and a bigint difference may not fit one.
 *
 * @param left - The first value.
 * @param right - The second value.
 * @return -1, 0 or 1.
 */
export function compareBigInt(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * The integer square root of a non-negative bigint: the largest `r` with `r * r <= value`,
 * as wire-sysio's `opp::amm::isqrt` floors it. Newton's method from above.
 *
 * @param value - A non-negative value.
 * @return Its floored square root.
 * @throws When `value` is negative.
 */
export function isqrt(value: bigint): bigint {
  if (value < 0n) {
    throw new RangeError(`isqrt: ${value} is negative`)
  }
  const step = (root: bigint): bigint => {
    const next = (root + value / root) / 2n
    return next >= root ? root : step(next)
  }
  return value < 2n ? value : step(value)
}

/**
 * `ceil(numerator / denominator)` for bigints: the least `q` with `q * denominator >= numerator`.
 * bigint division truncates, so a rounded-up quotient needs this.
 *
 * @param numerator - A non-negative value.
 * @param denominator - A positive value.
 * @return The quotient, rounded up.
 * @throws When `numerator` is negative or `denominator` is not positive.
 */
export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) {
    throw new RangeError(
      `ceilDiv: ${numerator} / ${denominator} needs a non-negative numerator and a positive denominator`
    )
  }
  return (numerator + denominator - 1n) / denominator
}
