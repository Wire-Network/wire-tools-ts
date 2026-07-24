import { ethers } from "ethers"
import {
  contractView,
  ethereumRevertReason,
  resolveLatestNonce
} from "@wireio/cluster-tool/utils"

/** A minimal typed view over one ERC-20 read — what a harness tool declares. */
interface BalanceReadView extends ethers.BaseContract {
  balanceOf: (address: string) => Promise<bigint>
}

const SomeAddress = "0x00000000000000000000000000000000000000aa"
const BalanceAbi: ethers.InterfaceAbi = [
  "function balanceOf(address owner) view returns (uint256)"
]

describe("contractView", () => {
  it("returns a real ethers Contract presented as the view", () => {
    const view = contractView<BalanceReadView>(SomeAddress, BalanceAbi, null)
    expect(view).toBeInstanceOf(ethers.BaseContract)
    expect(typeof view.balanceOf).toBe("function")
    expect(view.target).toBe(SomeAddress)
  })

  it("stays assignable to BaseContract consumers with no re-cast", () => {
    const view = contractView<BalanceReadView>(SomeAddress, BalanceAbi, null)
    // The intersection carries BaseContract statically — the compile of this
    // assignment IS the assertion; the runtime check is a formality.
    const base: ethers.BaseContract = view
    expect(base.target).toBe(SomeAddress)
  })
})

describe("resolveLatestNonce", () => {
  it("throws when the contract is not bound to a Signer", async () => {
    const view = contractView<BalanceReadView>(SomeAddress, BalanceAbi, null)
    await expect(resolveLatestNonce(view)).rejects.toThrow(
      /must be bound to a Signer/
    )
  })

  it("throws when count is not a positive integer", async () => {
    const view = contractView<BalanceReadView>(SomeAddress, BalanceAbi, null)
    await expect(resolveLatestNonce(view, 0)).rejects.toThrow(
      /count must be a positive integer/
    )
    await expect(resolveLatestNonce(view, 1.5)).rejects.toThrow(
      /count must be a positive integer/
    )
  })

  it("reserves a contiguous block: returns the first nonce and advances by count", async () => {
    const signer = stubSigner("0x00000000000000000000000000000000000000bb", 7),
      view = contractView<BalanceReadView>(SomeAddress, BalanceAbi, signer)
    // First call seeds from the chain and reserves 3 nonces (7, 8, 9).
    expect(await resolveLatestNonce(view, 3)).toBe(7)
    // The next reservation starts where the block ended.
    expect(await resolveLatestNonce(view)).toBe(10)
    expect(await resolveLatestNonce(view, 2)).toBe(11)
    expect(await resolveLatestNonce(view)).toBe(13)
  })
})

/**
 * Minimal Signer + Provider stub for nonce accounting: the only calls
 * `resolveLatestNonce` makes are `getAddress()` and
 * `provider.getTransactionCount(addr, "latest")`.
 */
function stubSigner(address: string, chainNonce: number): ethers.Signer {
  const provider = {
    getTransactionCount: async () => chainNonce
  } as unknown as ethers.Provider
  return {
    provider,
    getAddress: async () => address
  } as unknown as ethers.Signer
}

describe("ethereumRevertReason", () => {
  it("prefers the decoded require reason over every other field", () => {
    expect(
      ethereumRevertReason({
        reason: "insufficient collateral",
        shortMessage: "execution reverted",
        message: "execution reverted (long form)"
      })
    ).toBe("insufficient collateral")
  })

  it("falls back to shortMessage, then message", () => {
    expect(
      ethereumRevertReason({
        shortMessage: "execution reverted",
        message: "execution reverted (long form)"
      })
    ).toBe("execution reverted")
    expect(ethereumRevertReason(new Error("plain failure"))).toBe("plain failure")
  })

  it("stringifies a reason-less value instead of losing it", () => {
    expect(ethereumRevertReason("raw string error")).toBe("raw string error")
  })
})
