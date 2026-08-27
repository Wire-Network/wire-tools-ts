import Dgram from "node:dgram"
import { Deferred } from "@wireio/shared"
import {
  assertEndpoint,
  EndpointPattern,
  filterSocketLinesByLocalPort,
  isUdpPortFree,
  ListenAllAddress,
  Localhost,
  MaximumPort,
  MinimumPort,
  toAddress,
  toDialAddress,
  toURL,
  URLScheme
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
      expect(toURL(8899, Localhost, URLScheme.ws)).toBe("ws://127.0.0.1:8899")
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
      const lines = filterSocketLinesByLocalPort(
        SsOutput,
        new Set([8000, 8899])
      )
      expect(lines).toHaveLength(2)
      expect(lines[0]).toContain("0.0.0.0:8000")
      expect(lines[1]).toContain("[::]:8899")
    })

    it("matches nothing for ports absent from the output (header never matches)", () => {
      expect(
        filterSocketLinesByLocalPort(SsOutput, new Set([12000]))
      ).toHaveLength(0)
      expect(filterSocketLinesByLocalPort(SsOutput, new Set())).toHaveLength(0)
    })
  })

  describe("toDialAddress", () => {
    it("maps the listen wildcard (0.0.0.0) to loopback", () => {
      expect(toDialAddress(ListenAllAddress)).toBe(Localhost)
    })
    it("maps an empty address to loopback", () => {
      expect(toDialAddress("")).toBe(Localhost)
    })
    it("passes loopback through verbatim", () => {
      expect(toDialAddress(Localhost)).toBe(Localhost)
    })
    it("passes a remote / LAN / hostname address through verbatim", () => {
      expect(toDialAddress("10.0.0.5")).toBe("10.0.0.5")
      expect(toDialAddress("rpc.testnet.example")).toBe("rpc.testnet.example")
    })
  })

  describe("assertEndpoint", () => {
    it("pins the port bounds it enforces", () => {
      expect(MinimumPort).toBe(1)
      expect(MaximumPort).toBe(65_535)
    })

    it.each([
      "127.0.0.1:8888",
      "0.0.0.0:9876",
      "10.0.0.1:80",
      "host:8888",
      "rpc.testnet.example:443",
      "peer-a.example:9876",
      "under_score.host:1",
      "[::1]:8888",
      "[fe80::1]:65535"
    ])("accepts the scheme-less endpoint %s", endpoint => {
      expect(() => assertEndpoint(endpoint, "field")).not.toThrow()
      expect(EndpointPattern.test(endpoint)).toBe(true)
    })

    it("accepts what toAddress builds, for both address families", () => {
      // The producer and the validator must agree by construction.
      expect(() => assertEndpoint(toAddress(8888), "field")).not.toThrow()
      expect(() =>
        assertEndpoint(toAddress(8888, "::1"), "field")
      ).not.toThrow()
    })

    it("REJECTS a URL — the host group excludes the scheme separators", () => {
      // A permissive `\S+` host accepted `http://host` as a "host"; nodeop
      // takes only the scheme-less form, so a URL has to fail HERE rather than
      // at daemon startup on the deploy host.
      expect(() => assertEndpoint("http://host:8888", "field")).toThrow(
        /field must be <address>:<port>/
      )
      expect(EndpointPattern.test("http://host:8888")).toBe(false)
      expect(() => assertEndpoint("ws://10.0.0.1:8899", "field")).toThrow(
        /field must be <address>:<port>/
      )
      expect(() => assertEndpoint(toURL(8888, Localhost), "field")).toThrow(
        /field must be <address>:<port>/
      )
    })

    it.each([
      "host",
      "host:",
      ":8888",
      "host:not-a-port",
      "host:123456",
      "ho st:8888",
      "host/path:8888",
      "::1:8888"
    ])("REJECTS the malformed endpoint %s", endpoint => {
      expect(() => assertEndpoint(endpoint, "field")).toThrow(
        /field must be <address>:<port>/
      )
    })

    it("REJECTS a port outside the bounds, naming them", () => {
      expect(() => assertEndpoint("host:0", "field")).toThrow(
        /field port must be 1–65535 — got 0/
      )
      expect(() => assertEndpoint("host:99999", "field")).toThrow(
        /field port must be/
      )
      // The shape allows 5 digits, so the RANGE check is what stops 65536.
      expect(EndpointPattern.test("host:65536")).toBe(true)
      expect(() => assertEndpoint("host:65536", "field")).toThrow(
        /field port must be/
      )
    })

    it("names the caller's label verbatim in every message", () => {
      expect(() =>
        assertEndpoint("nope", "ApiNodeConfig: p2pPeerAddresses[1]")
      ).toThrow(/ApiNodeConfig: p2pPeerAddresses\[1\] must be/)
    })
  })
})
