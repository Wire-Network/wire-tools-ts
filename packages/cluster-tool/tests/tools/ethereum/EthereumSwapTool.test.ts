import {
  EthereumLocalReserveStatus,
  parseEthereumSwapSourceRequestId
} from "@wireio/cluster-tool/tools/ethereum"

describe("EthereumSwapTool", () => {
  describe("EthereumLocalReserveStatus", () => {
    it("mirrors ReserveManager.sol::LocalReserveStatus's zero-indexed values", () => {
      // Deliberately ≠ the proto ReserveStatus (UNKNOWN=0, PENDING=1, ...) —
      // shifting these by one breaks every outpost-local status comparison.
      expect(EthereumLocalReserveStatus.PENDING).toBe(0)
      expect(EthereumLocalReserveStatus.ACTIVE).toBe(1)
      expect(EthereumLocalReserveStatus.CANCELLED).toBe(2)
    })
  })

  describe("parseEthereumSwapSourceRequestId", () => {
    it("reads the indexed id from the canonical SwapDeposit event", () => {
      expect(
        parseEthereumSwapSourceRequestId([
          { eventName: "SwapDeposit", args: [42n] } as never
        ])
      ).toBe(42n)
    })

    it("rejects a confirmed receipt without SwapDeposit", () => {
      expect(() => parseEthereumSwapSourceRequestId([])).toThrow(
        /did not emit SwapDeposit/
      )
    })
  })
})
