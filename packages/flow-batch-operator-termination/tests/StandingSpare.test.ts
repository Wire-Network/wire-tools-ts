import {
  assertCompleteSchedule,
  assertStandingSpare
} from "@wireio/test-flow-batch-operator-termination/StandingSpare.js"

const Groups = [
  ["a", "b", "c"],
  ["d", "e", "f"],
  ["g", "h", "i"]
]

describe("assertStandingSpare", () => {
  test("selects one of two active operators outside the nine-seat window", () => {
    expect(assertStandingSpare(new Set([...Groups.flat(), "k", "j"]), Groups, 2)).toBe("j")
  })

  test("rejects an incomplete or inactive schedule instead of slashing a seat", () => {
    expect(() =>
      assertStandingSpare(new Set([...Groups.flat(), "j"]), Groups, 2)
    ).toThrow("standing-spare pool changed")
    expect(() =>
      assertStandingSpare(new Set([...Groups.flat().slice(1), "j", "k"]), Groups, 2)
    ).toThrow("inactive member")
  })

  test("rejects duplicate seats and an empty spare pool", () => {
    expect(() =>
      assertStandingSpare(new Set([...Groups.flat(), "j", "k"]),
        [Groups[0], Groups[1], ["g", "h", "h"]], 2)
    ).toThrow()
    expect(() =>
      assertStandingSpare(new Set(Groups.flat()), Groups, 0)
    ).toThrow("no standing spare")
  })
})

describe("assertCompleteSchedule", () => {
  test("accepts nine disjoint seats with two additional standing spares", () => {
    expect(() => assertCompleteSchedule(Groups)).not.toThrow()
  })

  test("rejects a short group or duplicate seat", () => {
    expect(() => assertCompleteSchedule([Groups[0], Groups[1], ["g", "h"]])).toThrow(
      "short group"
    )
    expect(() => assertCompleteSchedule([Groups[0], Groups[1], ["g", "h", "h"]])).toThrow(
      "more than one group"
    )
  })
})
