import {
  ListenAllAddress,
  Localhost,
  toAddress,
  toURL
} from "@wireio/test-cluster-tool/utils"

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
})
