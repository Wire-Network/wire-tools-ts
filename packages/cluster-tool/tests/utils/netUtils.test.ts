import Dgram from "node:dgram"
import { Deferred } from "@wireio/shared"
import {
  filterSocketLinesByLocalPort,
  isUdpPortFree,
  ListenAllAddress,
  Localhost,
  toAddress,
  toURL
} from "@wireio/cluster-tool/utils"

describe("netUtils", () => {
  it("exposes the loopback and bind-all address constants", () => {
    expect(Localhost).toBe("127.0.0.1")
    expect(ListenAllAddress).toBe("0.0.0.0")
  })

  describe("toAddress", () => {
    it("defaults to loopback", () => {
      expect(toAddress(8888)).toBe("127.0.0.1:8888")
    })
    it("accepts an explicit address", () => {
      expect(toAddress(9876, ListenAllAddress)).toBe("0.0.0.0:9876")
    })
  })

  describe("toURL", () => {
    it("builds an http URL by default", () => {
      expect(toURL(8888)).toBe("http://127.0.0.1:8888")
    })
    it("accepts a scheme and address", () => {
      expect(toURL(8899, Localhost, "ws")).toBe("ws://127.0.0.1:8899")
    })
  })

  describe("isUdpPortFree", () => {
    it("is false while a UDP socket holds the port, true after release", async () => {
      // OS-assigned port (never a fixed bind — see bind-available-ports rule).
      const holder = Dgram.createSocket("udp4")
      const port = await Deferred.useCallback<number>(deferred =>
        holder.bind(0, () => deferred.resolve(holder.address().port))
      ).promise
      expect(await isUdpPortFree(port)).toBe(false)
      await Deferred.useCallback<void>(deferred =>
        holder.close(() => deferred.resolve())
      ).promise
      expect(await isUdpPortFree(port)).toBe(true)
    })
  })

  describe("filterSocketLinesByLocalPort", () => {
    const SsOutput = [
      "Netid State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process",
      'udp   UNCONN 0      0            0.0.0.0:8000       0.0.0.0:*     users:(("solana-test-val",pid=4242,fd=17))',
      'tcp   LISTEN 0      511             [::]:8899          [::]:*     users:(("solana-test-val",pid=4242,fd=33))',
      'tcp   LISTEN 0      128        127.0.0.1:9999       0.0.0.0:*     users:(("unrelated",pid=1,fd=3))'
    ].join("\n")

    it("keeps only lines whose LOCAL port matches, across v4/v6 forms", () => {
      const lines = filterSocketLinesByLocalPort(SsOutput, new Set([8000, 8899]))
      expect(lines).toHaveLength(2)
      expect(lines[0]).toContain("0.0.0.0:8000")
      expect(lines[1]).toContain("[::]:8899")
    })

    it("matches nothing for ports absent from the output (header never matches)", () => {
      expect(filterSocketLinesByLocalPort(SsOutput, new Set([12000]))).toHaveLength(0)
      expect(filterSocketLinesByLocalPort(SsOutput, new Set())).toHaveLength(0)
    })
  })
})
