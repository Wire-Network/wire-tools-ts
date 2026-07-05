import { OutputStore, outputKey } from "@wireio/cluster-tool/orchestration"

describe("OutputStore", () => {
  const countKey = outputKey<number>("count", "a count")
  const objectKey = outputKey<{ id: string }>("obj", "an object")

  it("set/get round-trips a typed value (null when absent)", () => {
    const store = new OutputStore()
    expect(store.get(countKey)).toBeNull()
    expect(store.has(countKey)).toBe(false)
    store.set(countKey, 42)
    expect(store.get(countKey)).toBe(42)
    expect(store.has(countKey)).toBe(true)
  })

  it("require returns the value, or throws naming the missing key", () => {
    const store = new OutputStore()
    expect(() => store.assert(objectKey)).toThrow(/Missing asserted output: obj/)
    store.set(objectKey, { id: "x" })
    expect(store.assert(objectKey)).toEqual({ id: "x" })
  })

  it("set is fluent and keys are independent", () => {
    const store = new OutputStore().set(countKey, 1).set(objectKey, { id: "y" })
    expect(store.get(countKey)).toBe(1)
    expect(store.get(objectKey)).toEqual({ id: "y" })
  })
})
