import Net from "node:net"
import { Deferred } from "@wireio/shared"
import { BindConfigProvider } from "@wireio/cluster-tool/config"
import { isIpv6PortFree, Localhost } from "@wireio/cluster-tool/utils"

describe("BindConfigProvider wildcard probes", () => {
  it.each([Localhost, "::1"])(
    "rejects an occupied port on %s and accepts it after release",
    async host => {
      const port = await BindConfigProvider.findAvailable(
        BindConfigProvider.DefaultKiod
      )
      const holder = Net.createServer()
      try {
        await Deferred.useCallback<void>(deferred => {
          holder.once("error", error => deferred.reject(error))
          holder.listen({ port, host, ipv6Only: true }, () =>
            deferred.resolve()
          )
        }).promise
        await BindConfigProvider.clearPortLocks()
        expect(await BindConfigProvider.isPortAvailable(port)).toBe(false)
        await BindConfigProvider.clearPortLocks()
        expect(await BindConfigProvider.findAvailable(port)).not.toBe(port)
        await BindConfigProvider.clearPortLocks()
        await expect(
          BindConfigProvider.pickPort(port, null, new Set(), "network-test")
        ).rejects.toThrow(/pinned but unavailable/)
      } finally {
        if (holder.listening) {
          await Deferred.useCallback<void>(deferred =>
            holder.close(() => deferred.resolve())
          ).promise
        }
      }
      await BindConfigProvider.clearPortLocks()
      expect(await BindConfigProvider.isPortAvailable(port)).toBe(true)
    }
  )

  it.each([
    ["EAFNOSUPPORT", true],
    ["EADDRNOTAVAIL", true],
    ["EACCES", false],
    ["EADDRINUSE", false]
  ])(
    "handles IPv6 probe error %s without leaking a listener",
    async (code, available) => {
      const port = await BindConfigProvider.findAvailable(
        BindConfigProvider.DefaultKiod
      )
      const probe = Net.createServer()
      jest.spyOn(probe, "listen").mockImplementation(() => {
        const error: NodeJS.ErrnoException = new Error(String(code))
        error.code = String(code)
        queueMicrotask(() => probe.emit("error", error))
        return probe
      })
      const create = jest.spyOn(Net, "createServer").mockReturnValue(probe)
      try {
        expect(await isIpv6PortFree(port)).toBe(available)
        expect(probe.listening).toBe(false)
      } finally {
        create.mockRestore()
      }
    }
  )
})
