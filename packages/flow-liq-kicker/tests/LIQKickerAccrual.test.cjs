const Assert = require("node:assert/strict")
const { test } = require("node:test")
const { LIQKickerAccrual } = require("../lib/LIQKickerAccrual.js")

// The mock pools' supply and reserves, and a 600.5 s interval — the shape of the live flow's
// manual kick. Expected values are wire-sysio's kicker_test_reference.hpp formula:
// floor(floor(S*r*e / (1e4 * 31,557,600 * 1e6)) * floor((W << 64) / Sh) >> 64).
const Supply = 10_000_000_000n
const ElapsedMicros = 600_500_000n

test("interest is the floored simple accrual over a Julian year", () => {
  Assert.equal(LIQKickerAccrual.interest(Supply, 200n, ElapsedMicros), 3805n)
  Assert.equal(LIQKickerAccrual.interest(Supply, 200n, 0n), 0n)
  // One full Julian year at 200 bps is exactly 2 % of supply.
  Assert.equal(LIQKickerAccrual.interest(Supply, 200n, 31_557_600_000_000n), 200_000_000n)
})

test("gift prices the interest at the pool's Q64.64 spot ratio, floored", () => {
  const gift = (poolWire, poolShadow) =>
    LIQKickerAccrual.gift({ supply: Supply, rateBps: 200n, elapsedMicros: ElapsedMicros, poolWire, poolShadow })
  Assert.equal(gift(10_000_000_000n, 10_000_000_000n), 3805n)
  Assert.equal(gift(20_000_000_000n, 10_000_000_000n), 7610n)
  Assert.equal(gift(10_000_000_000n, 30_000_000_000n), 1268n)
})

test("a pool with no shadow reserve has no price", () => {
  Assert.throws(() => LIQKickerAccrual.priceFixedPoint(1n, 0n), /must be positive/)
})

test("distribute grows the pot by the gift and the index by gift x 1e12 / supply, carrying the remainder", () => {
  Assert.deepEqual(
    LIQKickerAccrual.distribute({ index: "5", pot: 11, carry: 7 }, 3805n, Supply),
    { index: "380505", pot: "3816", carry: "7" }
  )
  Assert.deepEqual(
    LIQKickerAccrual.distribute({ index: "0", pot: 0, carry: 0 }, 1n, 3n),
    { index: "333333333333", pot: "1", carry: "1" }
  )
})

test("distribute refuses an empty supply, as sysio.liq does", () => {
  Assert.throws(() => LIQKickerAccrual.distribute({ index: "0", pot: 0, carry: 0 }, 1n, 0n), /must be positive/)
})
