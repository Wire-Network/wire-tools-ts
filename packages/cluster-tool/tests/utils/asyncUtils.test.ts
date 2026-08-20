import {
  FlowTimeoutScaleEnvVar,
  MaxFlowTimeoutScale,
  MinFlowTimeoutScale,
  eachSeries,
  flowTimeoutScale,
  mapSeries,
  retry,
  scaleTimeoutMs,
  serialize,
  sleep,
  toURL,
  waitForEndpoint
} from "@wireio/cluster-tool/utils"
import { BindConfigProvider } from "@wireio/cluster-tool/config"

describe("asyncUtils", () => {
  describe("sleep", () => {
    it("resolves after roughly the given delay", async () => {
      const start = Date.now()
      await sleep(30)
      expect(Date.now() - start).toBeGreaterThanOrEqual(25)
    })
  })

  describe("retry", () => {
    it("returns on the first success without retrying", async () => {
      const fn = jest.fn().mockResolvedValue("ok")
      expect(await retry(fn)).toBe("ok")
      expect(fn).toHaveBeenCalledTimes(1)
    })
    it("retries on failure then succeeds", async () => {
      const fn = jest.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue("ok")
      expect(await retry(fn, { maxAttempts: 3, delayMs: 1 })).toBe("ok")
      expect(fn).toHaveBeenCalledTimes(2)
    })
    it("throws the last error after exhausting attempts", async () => {
      const fn = jest.fn().mockRejectedValue(new Error("always"))
      await expect(retry(fn, { maxAttempts: 2, delayMs: 1 })).rejects.toThrow("always")
      expect(fn).toHaveBeenCalledTimes(2)
    })
    it("checkResult=true rethrows immediately (the error IS the result)", async () => {
      const fn = jest.fn().mockRejectedValue(new Error("chain rejection"))
      await expect(
        retry(fn, {
          maxAttempts: 5,
          delayMs: 1,
          checkResult: error => error instanceof Error && error.message === "chain rejection"
        })
      ).rejects.toThrow("chain rejection")
      expect(fn).toHaveBeenCalledTimes(1)
    })
    it("checkResult=false keeps retrying the transient class", async () => {
      const fn = jest
        .fn()
        .mockRejectedValueOnce(new Error("Connection refused"))
        .mockRejectedValueOnce(new Error("Connection refused"))
        .mockResolvedValue("ok")
      expect(
        await retry(fn, {
          maxAttempts: 4,
          delayMs: 1,
          checkResult: error => !(error instanceof Error && error.message.includes("Connection refused"))
        })
      ).toBe("ok")
      expect(fn).toHaveBeenCalledTimes(3)
    })
  })

  describe("waitForEndpoint", () => {
    let fetchSpy: jest.SpyInstance
    let url: string
    beforeAll(async () => {
      url = `${toURL(await BindConfigProvider.findAvailable(BindConfigProvider.DefaultBiosHttp))}/v1/chain/get_info`
    })
    afterEach(() => fetchSpy.mockRestore())

    it("resolves when the endpoint returns 2xx", async () => {
      fetchSpy = jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }))
      await expect(waitForEndpoint(url, { timeoutMs: 1_000, intervalMs: 1 })).resolves.toBeUndefined()
    })
    it("resolves on a liveness status (404) even when not ok", async () => {
      fetchSpy = jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }))
      await expect(waitForEndpoint(url, { timeoutMs: 1_000, intervalMs: 1 })).resolves.toBeUndefined()
    })
    it("throws after the timeout when never reachable", async () => {
      fetchSpy = jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"))
      await expect(waitForEndpoint(url, { timeoutMs: 20, intervalMs: 5 })).rejects.toThrow(/did not become ready/)
    })
  })
})

describe("mapSeries / eachSeries (AsyncLocalStorage-safe sequential iteration)", () => {
  it("maps sequentially, in order, with indexes", async () => {
    const order: number[] = []
    const results = await mapSeries([10, 20, 30], async (item, index) => {
      order.push(index)
      await sleep(1)
      return item + index
    })
    expect(results).toEqual([10, 21, 32])
    expect(order).toEqual([0, 1, 2])
  })

  it("eachSeries runs effects strictly in order", async () => {
    const seen: string[] = []
    await eachSeries(["a", "b"], async item => {
      seen.push(`start-${item}`)
      await sleep(1)
      seen.push(`end-${item}`)
    })
    expect(seen).toEqual(["start-a", "end-a", "start-b", "end-b"])
  })

  it("preserves the step recorder scope even nested under a Bluebird chain", async () => {
    // The live composition that LOST records: Bluebird drains its shared
    // callback queue under the scheduling context, so a Bluebird iteration
    // inside a step detached from StepExtraRecorder's AsyncLocalStorage.
    // The native helpers must hold the scope through the same nesting.
    const { StepExtraRecorder } = await import("@wireio/cluster-tool/report")
    const Bluebird = (await import("bluebird")).default
    const recorder = new StepExtraRecorder()
    await Bluebird.each([1], async () => {
      await StepExtraRecorder.runWith(recorder, async () => {
        await mapSeries([1, 2], async item => {
          StepExtraRecorder.record({ client: "clio", kind: "cli", item })
        })
      })
    })
    expect(recorder.calls.map(call => call.item)).toEqual([1, 2])
  })
})

describe("flowTimeoutScale / scaleTimeoutMs", () => {
  afterEach(() => {
    delete process.env[FlowTimeoutScaleEnvVar]
  })

  it("defaults to 1 and clamps into [1, 5]", () => {
    expect(flowTimeoutScale()).toBe(1)
    process.env[FlowTimeoutScaleEnvVar] = "0.1"
    expect(flowTimeoutScale()).toBe(MinFlowTimeoutScale)
    process.env[FlowTimeoutScaleEnvVar] = "50"
    expect(flowTimeoutScale()).toBe(MaxFlowTimeoutScale)
    process.env[FlowTimeoutScaleEnvVar] = "2.5"
    expect(flowTimeoutScale()).toBe(2.5)
  })

  it("scaleTimeoutMs multiplies and rounds", () => {
    process.env[FlowTimeoutScaleEnvVar] = "3"
    expect(scaleTimeoutMs(60_000)).toBe(180_000)
    expect(scaleTimeoutMs(333)).toBe(999)
  })
})

describe("serialize", () => {
  /** Work that reports the peak number of concurrent bodies it ever saw. */
  function trackingWork() {
    const state = { inFlight: 0, peak: 0, order: [] as number[] }
    const work = (id: number) => async () => {
      state.inFlight += 1
      state.peak = Math.max(state.peak, state.inFlight)
      await sleep(5)
      state.order.push(id)
      state.inFlight -= 1
      return id
    }
    return { state, work }
  }

  it("never runs two bodies of the same key concurrently", async () => {
    const { state, work } = trackingWork()
    const results = await Promise.all([1, 2, 3, 4, 5].map(id => serialize("same", work(id))))
    expect(state.peak).toBe(1)
    expect(results).toEqual([1, 2, 3, 4, 5])
    expect(state.order).toEqual([1, 2, 3, 4, 5]) // FIFO, not just serialized
  })

  it("lets DIFFERENT keys proceed concurrently", async () => {
    const { state, work } = trackingWork()
    await Promise.all([serialize("key-a", work(1)), serialize("key-b", work(2)), serialize("key-c", work(3))])
    expect(state.peak).toBeGreaterThan(1)
  })

  it("a REJECTED predecessor does not stall the queue", async () => {
    const failure = serialize("stall", async () => {
      throw new Error("boom")
    })
    const follower = serialize("stall", async () => "ran anyway")
    await expect(failure).rejects.toThrow("boom")
    // The whole point: one operator's funding failure must not strand the rest.
    await expect(follower).resolves.toBe("ran anyway")
  })

  it("propagates each caller's OWN outcome", async () => {
    const ok = serialize("own", async () => "fine")
    const bad = serialize("own", async () => {
      throw new Error("mine")
    })
    const alsoOk = serialize("own", async () => "also fine")
    await expect(ok).resolves.toBe("fine")
    await expect(bad).rejects.toThrow("mine")
    await expect(alsoOk).resolves.toBe("also fine")
  })
})
