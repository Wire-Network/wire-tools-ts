import { ethers } from "ethers"
import {
  contractView,
  resolveLatestNonce
} from "@wireio/test-cluster-tool/utils"

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
})
