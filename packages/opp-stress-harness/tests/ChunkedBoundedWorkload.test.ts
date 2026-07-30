import { runChunkedBoundedWorkload } from "@wireio/opp-stress-harness"

describe("runChunkedBoundedWorkload", () => {
  it("preserves whole-workload indexes across chunk boundaries", async () => {
    // Given: three requests run two-at-a-time.
    const result = await runChunkedBoundedWorkload({
      requests: ["a", "b", "c"],
      concurrency: 2,
      submit: async (request, index) => `${request}:${index}`
    })

    // Then: successes carry their original positions, not per-chunk offsets.
    expect(result.failures).toEqual([])
    expect(result.successes.map(success => success.index)).toEqual([0, 1, 2])
    expect(result.successes.map(success => success.id)).toEqual([
      "a:0",
      "b:1",
      "c:2"
    ])
  })

  it("captures a failure against its original request index", async () => {
    // Given: one request whose submitter throws.
    const result = await runChunkedBoundedWorkload({
      requests: ["ok", "bad"],
      concurrency: 1,
      submit: async request => {
        if (request === "bad") throw new Error("boom")
        return request
      }
    })

    // Then: the success and failure keep their whole-workload indexes.
    expect(result.successes.map(success => success.index)).toEqual([0])
    expect(result.failures.map(failure => failure.index)).toEqual([1])
    expect(typeof result.failures[0]?.reason).toBe("string")
  })

  it("rejects a non-positive concurrency", async () => {
    await expect(
      runChunkedBoundedWorkload({
        requests: [],
        concurrency: 0,
        submit: request => Promise.resolve(request)
      })
    ).rejects.toThrow(/concurrency must be positive/)
  })
})
