import { WIREClient } from "@wireio/test-cluster-tool"

describe("WIREClient.getWireBalance", () => {
  function clientWithBalances(rows: string[]): WIREClient {
    const client = Object.create(WIREClient.prototype) as WIREClient
    ;(client as any).api = {
      v1: {
        chain: {
          get_currency_balance: jest.fn().mockResolvedValue(rows)
        }
      }
    }
    return client
  }

  it("parses a 9-decimal asset string into raw base units", async () => {
    const client = clientWithBalances(["12.345678901 WIRE"])
    await expect(client.getWireBalance("alice")).resolves.toBe(12_345_678_901n)
  })

  it("pads short fractional parts", async () => {
    const client = clientWithBalances(["1.5 WIRE"])
    await expect(client.getWireBalance("alice")).resolves.toBe(1_500_000_000n)
  })

  it("returns 0n when the account holds no WIRE row", async () => {
    const client = clientWithBalances([])
    await expect(client.getWireBalance("nobody")).resolves.toBe(0n)
  })
})
