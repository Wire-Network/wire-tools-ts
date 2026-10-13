import { NodeopReadMode } from "@wireio/cluster-tool-shared"

describe("NodeopReadMode", () => {
  it("is an identity-mapped string enum (value === key) for every member", () => {
    Object.entries(NodeopReadMode).forEach(([key, value]) =>
      expect(value).toBe(key)
    )
    expect(Object.values(NodeopReadMode)).toEqual([
      "head",
      "irreversible",
      "speculative"
    ])
  })
})
