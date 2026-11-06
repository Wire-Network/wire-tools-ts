import { MaximumUint32, Uint32Schema } from "@wireio/cluster-tool-shared"

/** `2^32`: one past the largest `uint32`. */
const Uint32Range = 2 ** 32

describe("MaximumUint32", () => {
  it("is the largest uint32", () => {
    expect(MaximumUint32).toBe(Uint32Range - 1)
  })
})

describe("Uint32Schema", () => {
  it.each([0, 1, MaximumUint32])("accepts %d", value => {
    expect(Uint32Schema.safeParse(value).success).toBe(true)
  })

  it.each([-1, MaximumUint32 + 1, 1.5, Number.NaN])("rejects %d", value => {
    expect(Uint32Schema.safeParse(value).success).toBe(false)
  })
})
