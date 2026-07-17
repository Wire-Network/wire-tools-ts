import { ClusterKeepAlive } from "@wireio/cluster-tool"

describe("ClusterKeepAlive", () => {
  it("arms a non-unref'd interval at KeepAliveIntervalMs", () => {
    const setIntervalSpy = jest.spyOn(global, "setInterval")
    try {
      const keepAlive = ClusterKeepAlive.create()
      expect(setIntervalSpy).toHaveBeenCalledWith(
        expect.any(Function),
        ClusterKeepAlive.KeepAliveIntervalMs
      )
      keepAlive.release()
    } finally {
      setIntervalSpy.mockRestore()
    }
  })

  it("wait resolves once release is called", async () => {
    const keepAlive = ClusterKeepAlive.create()
    const waited = keepAlive.wait()
    keepAlive.release()
    await expect(waited).resolves.toBeUndefined()
  })

  it("clears the keep-alive interval on release (no handle leak)", () => {
    const setIntervalSpy = jest.spyOn(global, "setInterval")
    const clearIntervalSpy = jest.spyOn(global, "clearInterval")
    try {
      const keepAlive = ClusterKeepAlive.create()
      const handle =
        setIntervalSpy.mock.results[setIntervalSpy.mock.results.length - 1].value
      keepAlive.release()
      expect(clearIntervalSpy).toHaveBeenCalledWith(handle)
    } finally {
      setIntervalSpy.mockRestore()
      clearIntervalSpy.mockRestore()
    }
  })

  it("release is idempotent — a second call neither re-clears nor throws", async () => {
    const clearIntervalSpy = jest.spyOn(global, "clearInterval")
    try {
      const keepAlive = ClusterKeepAlive.create()
      keepAlive.release()
      expect(() => keepAlive.release()).not.toThrow()
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1)
      await expect(keepAlive.wait()).resolves.toBeUndefined()
    } finally {
      clearIntervalSpy.mockRestore()
    }
  })
})
