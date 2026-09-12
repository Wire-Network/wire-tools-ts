import { assertReplacementQuorumPeer } from "@wireio/test-flow-batch-operator-termination/ReplacementQuorum.js"

const Replacements = ["replacementa", "replacementb"]
const OtherGroup = ["othera", "otherb", "otherc"]

describe("assertReplacementQuorumPeer", () => {
  test("selects the same original peer when both replacements share a group", () => {
    const groups = [OtherGroup, ["replacementb", "original", "replacementa"]]
    for (const replacement of Replacements) {
      expect(
        assertReplacementQuorumPeer(groups, Replacements, replacement)
      ).toBe("original")
    }
  })

  test("selects one original peer from each distinct replacement group", () => {
    const groups = [
      ["replacementa", "originala", "originalb"],
      ["replacementb", "originalc", "originald"]
    ]
    expect(
      assertReplacementQuorumPeer(groups, Replacements, "replacementa")
    ).toBe("originala")
    expect(
      assertReplacementQuorumPeer(groups, Replacements, "replacementb")
    ).toBe("originalc")
  })

  test("refuses a missing replacement instead of stopping an unrelated peer", () => {
    expect(() =>
      assertReplacementQuorumPeer([OtherGroup], Replacements, "replacementa")
    ).toThrow("replacementa is not seated")
  })

  test("refuses a target outside the replacement set", () => {
    expect(() =>
      assertReplacementQuorumPeer([OtherGroup], Replacements, "othera")
    ).toThrow("unknown replacement")
  })

  test("refuses extra peers that would allow quorum without the replacement", () => {
    expect(() =>
      assertReplacementQuorumPeer(
        [["replacementa", "originala", "originalb", "originalc"]],
        Replacements,
        "replacementa"
      )
    ).toThrow()
  })

  test("refuses duplicate seats and duplicate replacement identities", () => {
    expect(() =>
      assertReplacementQuorumPeer(
        [[...Replacements, "replacementa"]],
        Replacements,
        "replacementa"
      )
    ).toThrow()
    expect(() =>
      assertReplacementQuorumPeer(
        [["replacementa", "originala", "originalb"]],
        ["replacementa", "replacementa"],
        "replacementa"
      )
    ).toThrow()
  })
})
