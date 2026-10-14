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
