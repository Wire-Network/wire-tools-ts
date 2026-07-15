import { SingleFlightCache } from "@wireio/test-flow-batch-operator-slashing/SingleFlightCache.js"

describe("SingleFlightCache", () => {
  it("collapses concurrent misses for one key onto a single fetch", async () => {
    // Regression guard for the [P2] fix: the tip read must be single-flight so every parallel
    // delivery for one (chain_code, epoch) chains from the SAME pre-delivery tip. A non-single-flight
    // cache (populate-after-await) would let all three callers miss and issue their own read.
    const cache = new SingleFlightCache<string, number>()
    let calls = 0
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const fetch = async (): Promise<number> => {
      calls++
      await gate
      return 42
    }
    const inFlight = Promise.all([
      cache.get("k", fetch),
      cache.get("k", fetch),
      cache.get("k", fetch)
    ])
    release()
    expect(await inFlight).toEqual([42, 42, 42])
    expect(calls).toBe(1)
  })

  it("retains a resolved value so later gets do not re-fetch", async () => {
    const cache = new SingleFlightCache<string, number>()
    let calls = 0
    const fetch = async (): Promise<number> => {
      calls++
      return 7
    }
    expect(await cache.get("k", fetch)).toBe(7)
    expect(await cache.get("k", fetch)).toBe(7)
    expect(calls).toBe(1)
  })

  it("evicts a rejected fetch so a later get retries (no poisoning)", async () => {
    const cache = new SingleFlightCache<string, number>()
    let calls = 0
    const fetch = async (): Promise<number> => {
      calls++
      if (calls === 1) {
        throw new Error("read failed")
      }
      return 9
    }
    await expect(cache.get("k", fetch)).rejects.toThrow("read failed")
    expect(await cache.get("k", fetch)).toBe(9)
    expect(calls).toBe(2)
  })

  it("fetches independently per key", async () => {
    const cache = new SingleFlightCache<string, string>()
    const fetched: string[] = []
    const fetch = (value: string) => async (): Promise<string> => {
      fetched.push(value)
      return value
    }
    const [a, b] = await Promise.all([
      cache.get("a", fetch("a")),
      cache.get("b", fetch("b"))
    ])
    expect([a, b]).toEqual(["a", "b"])
    expect([...fetched].sort()).toEqual(["a", "b"])
  })
})
