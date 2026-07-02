import {
  retry,
  sleep,
  toURL,
  waitForEndpoint
} from "@wireio/test-cluster-tool/utils"
import { BindConfig } from "@wireio/test-cluster-tool/config"

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
      const fn = jest
        .fn()
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValue("ok")
      expect(await retry(fn, { maxAttempts: 3, delayMs: 1 })).toBe("ok")
      expect(fn).toHaveBeenCalledTimes(2)
    })
    it("throws the last error after exhausting attempts", async () => {
      const fn = jest.fn().mockRejectedValue(new Error("always"))
      await expect(retry(fn, { maxAttempts: 2, delayMs: 1 })).rejects.toThrow(
        "always"
      )
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
          checkResult: error =>
            !(error instanceof Error && error.message.includes("Connection refused"))
        })
      ).toBe("ok")
      expect(fn).toHaveBeenCalledTimes(3)
    })
  })

  describe("waitForEndpoint", () => {
    let fetchSpy: jest.SpyInstance
    let url: string
    beforeAll(async () => {
      url = `${toURL(await BindConfig.findAvailable(BindConfig.DefaultBiosHttp))}/v1/chain/get_info`
    })
    afterEach(() => fetchSpy.mockRestore())

    it("resolves when the endpoint returns 2xx", async () => {
      fetchSpy = jest
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(null, { status: 200 }))
      await expect(
        waitForEndpoint(url, { timeoutMs: 1_000, intervalMs: 1 })
      ).resolves.toBeUndefined()
    })
    it("resolves on a liveness status (404) even when not ok", async () => {
      fetchSpy = jest
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(null, { status: 404 }))
      await expect(
        waitForEndpoint(url, { timeoutMs: 1_000, intervalMs: 1 })
      ).resolves.toBeUndefined()
    })
    it("throws after the timeout when never reachable", async () => {
      fetchSpy = jest
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("ECONNREFUSED"))
      await expect(
        waitForEndpoint(url, { timeoutMs: 20, intervalMs: 5 })
      ).rejects.toThrow(/did not become ready/)
    })
  })
})
