import { formatWireAsset, provisionWireUser } from "@wireio/test-cluster-tool"
import { Clio } from "@wireio/test-cluster-tool/clients/Clio"

describe("WireUserTool", () => {
  describe("formatWireAsset", () => {
    it("formats whole + fractional 9-decimal base units", () => {
      expect(formatWireAsset(1_000_000_000n)).toBe("1.000000000 WIRE")
      expect(formatWireAsset(1_234_567_891n)).toBe("1.234567891 WIRE")
    })

    it("zero-pads sub-unit amounts", () => {
      expect(formatWireAsset(200n)).toBe("0.000000200 WIRE")
      expect(formatWireAsset(0n)).toBe("0.000000000 WIRE")
    })
  })

  describe("provisionWireUser", () => {
    function mockClio() {
      const clio = new Clio({
        clusterPath: "/tmp/wire-user-tool-test",
        binary: "clio",
        url: "http://127.0.0.1:8888"
      })
      jest.spyOn(clio, "walletOpenAndUnlock").mockResolvedValue(undefined)
      const createAccount = jest
        .spyOn(clio, "createAccount")
        .mockResolvedValue("txid")
      const pushActionAndWait = jest
        .spyOn(clio, "pushActionAndWait")
        .mockResolvedValue(undefined)
      return { clio, createAccount, pushActionAndWait }
    }

    it("creates the account, attaches a policy, and skips funding at 0", async () => {
      const { clio, createAccount, pushActionAndWait } = mockClio()
      const user = await provisionWireUser(clio, "wirercpt")

      expect(createAccount).not.toHaveBeenCalled()
      // Exactly two pushes (newaccount + addpolicy) — no transfer when fundWireAmount is 0.
      expect(pushActionAndWait).toHaveBeenCalledTimes(2)
      expect(pushActionAndWait.mock.calls[0][1]).toBe("newaccount")
      expect(pushActionAndWait.mock.calls[1][1]).toBe("addpolicy")
      expect(user.account).toBe("wirercpt")
      expect(Buffer.from(user.accountBytes).toString("utf-8")).toBe("wirercpt")
    })

    it("funds the account from the treasury when an amount is given", async () => {
      const { clio, pushActionAndWait } = mockClio()
      await provisionWireUser(clio, "wirefrom", {
        fundWireAmount: 2_000_000_000n
      })

      expect(pushActionAndWait).toHaveBeenCalledTimes(3)
      expect(pushActionAndWait).toHaveBeenNthCalledWith(
        3,
        "sysio.token",
        "transfer",
        expect.objectContaining({
          quantity: "2.000000000 WIRE",
          to: "wirefrom"
        }),
        "sysio@active"
      )
    })

    it("uses explicit resource policy weights when provided", async () => {
      const { clio, pushActionAndWait } = mockClio()
      await provisionWireUser(clio, "wirefrom", {
        resourcePolicy: {
          netWeight: "1.0000 SYS",
          ramWeight: "1.0000 SYS",
          cpuWeight: "1.0000 SYS"
        }
      })

      expect(pushActionAndWait).toHaveBeenNthCalledWith(
        2,
        "sysio.roa",
        "addpolicy",
        expect.objectContaining({
          net_weight: "1.0000 SYS",
          ram_weight: "1.0000 SYS",
          cpu_weight: "1.0000 SYS"
        }),
        expect.any(String)
      )
    })

    it("tolerates an already-existing account (idempotent re-runs)", async () => {
      const { clio, pushActionAndWait } = mockClio()
      pushActionAndWait.mockRejectedValueOnce(
        new Error("account name already exists")
      )
      await expect(provisionWireUser(clio, "wirercpt")).resolves.toBeDefined()
    })

    it("rethrows unexpected createAccount failures", async () => {
      const { clio, pushActionAndWait } = mockClio()
      pushActionAndWait.mockRejectedValueOnce(new Error("wallet locked"))
      await expect(provisionWireUser(clio, "wirercpt")).rejects.toThrow(
        "Failed to create account wirercpt"
      )
    })
  })
})
