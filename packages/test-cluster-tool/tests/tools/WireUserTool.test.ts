import { formatWireAsset, provisionWireUser } from "@wireio/test-cluster-tool"

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
      return {
        walletOpenAndUnlock: jest.fn().mockResolvedValue(undefined),
        createAccount: jest.fn().mockResolvedValue(undefined),
        pushActionAndWait: jest.fn().mockResolvedValue(undefined)
      }
    }

    it("creates the account, attaches a policy, and skips funding at 0", async () => {
      const clio = mockClio()
      const user = await provisionWireUser(clio as any, "wirercpt")

      expect(clio.createAccount).toHaveBeenCalledWith(
        "sysio", "wirercpt", expect.any(String), expect.any(String)
      )
      // Exactly one push (addpolicy) — no transfer when fundWireAmount is 0.
      expect(clio.pushActionAndWait).toHaveBeenCalledTimes(1)
      expect(clio.pushActionAndWait.mock.calls[0][1]).toBe("addpolicy")
      expect(user.account).toBe("wirercpt")
      expect(Buffer.from(user.accountBytes).toString("utf-8")).toBe("wirercpt")
    })

    it("funds the account from the treasury when an amount is given", async () => {
      const clio = mockClio()
      await provisionWireUser(clio as any, "wirefrom", {
        fundWireAmount: 2_000_000_000n
      })

      expect(clio.pushActionAndWait).toHaveBeenCalledTimes(2)
      const [, action, payload, auth] = clio.pushActionAndWait.mock.calls[1]
      expect(action).toBe("transfer")
      expect(payload.quantity).toBe("2.000000000 WIRE")
      expect(payload.to).toBe("wirefrom")
      expect(auth).toBe("sysio@active")
    })

    it("tolerates an already-existing account (idempotent re-runs)", async () => {
      const clio = mockClio()
      clio.createAccount.mockRejectedValueOnce(
        new Error("account name already exists")
      )
      await expect(provisionWireUser(clio as any, "wirercpt")).resolves.toBeDefined()
    })

    it("rethrows unexpected createAccount failures", async () => {
      const clio = mockClio()
      clio.createAccount.mockRejectedValueOnce(new Error("wallet locked"))
      await expect(provisionWireUser(clio as any, "wirercpt"))
        .rejects.toThrow("createAccount(wirercpt) failed")
    })
  })
})
