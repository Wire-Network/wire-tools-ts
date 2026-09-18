import { ReadinessOutputs } from "@wireio/cluster-tool/orchestration/outputs"

describe("ReadinessOutputs", () => {
  it("defines distinct typed keys for every cross-step readiness value", () => {
    const keys = Object.values(ReadinessOutputs)
    expect(new Set(keys.map(key => key.name)).size).toBe(keys.length)
    expect(keys.every(key => key.name.startsWith("readiness."))).toBe(true)
    expect(keys.every(key => key.description.length > 0)).toBe(true)
  })
})
