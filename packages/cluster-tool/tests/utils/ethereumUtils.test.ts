import { ethers } from "ethers"
import { BindConfigProvider } from "@wireio/cluster-tool/config"
import {
  clearNonceCache,
  contractView,
  ethereumRevertReason,
  resolveLatestNonce,
  toURL
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
})

describe("resolveLatestNonce — a Signer source", () => {
  /** The signer whose counter these cases exercise. */
  const SignerAddress = "0x00000000000000000000000000000000000000bb"
  /** What the stubbed chain reports as the account's mined nonce. */
  const SeedNonce = 42

  let rpcUrl: string, provider: ethers.JsonRpcProvider, signer: ethers.VoidSigner

  beforeAll(async () => {
    // The URL is a BOUND url — its port comes from the registry, never a
    // literal, even though nothing here dials it.
    rpcUrl = toURL(
      await BindConfigProvider.findAvailable(BindConfigProvider.DefaultAnvil)
    )
  })

  beforeEach(() => {
    provider = new ethers.JsonRpcProvider(rpcUrl)
    jest.spyOn(provider, "getTransactionCount").mockResolvedValue(SeedNonce)
    signer = new ethers.VoidSigner(SignerAddress, provider)
    clearNonceCache(SignerAddress)
  })

  afterEach(() => {
    clearNonceCache(SignerAddress)
    provider.destroy()
    jest.restoreAllMocks()
  })

  it("seeds from the chain, then increments in-process", async () => {
    expect(await resolveLatestNonce(signer)).toBe(SeedNonce)
    expect(await resolveLatestNonce(signer)).toBe(SeedNonce + 1)
    expect(await resolveLatestNonce(signer)).toBe(SeedNonce + 2)
    // Seeded once — every later draw is in-process, not another round-trip.
    expect(provider.getTransactionCount).toHaveBeenCalledTimes(1)
  })

  it("never hands the same nonce to concurrent callers", async () => {
    // The regression this guards: 2026-08-10, nonce 157 went to FOUR parallel
    // funding sends and three were rejected `nonce has already been used`.
    const nonces = await Promise.all(
      Array.from({ length: 22 }, () => resolveLatestNonce(signer))
    )
    expect(new Set(nonces).size).toBe(nonces.length)
    expect([...nonces].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 22 }, (_, index) => SeedNonce + index)
    )
  })

  it("shares ONE counter between a contract and its own signer", async () => {
    // A contract write and a bare value transfer from the same account must
    // draw from the same sequence — that is why the signer form exists.
    const view = contractView<BalanceReadView>(SomeAddress, BalanceAbi, signer)
    expect(await resolveLatestNonce(view)).toBe(SeedNonce)
    expect(await resolveLatestNonce(signer)).toBe(SeedNonce + 1)
    expect(await resolveLatestNonce(view)).toBe(SeedNonce + 2)
  })

  it("throws when the signer has no Provider", async () => {
    await expect(
      resolveLatestNonce(new ethers.VoidSigner(SignerAddress))
    ).rejects.toThrow(/must have a Provider/)
  })

  it("reserves a contiguous block and advances the counter past it", async () => {
    // The regression this guards: a burst reserved ONE nonce, submitted 12
    // transactions on 42..53, and left the counter at 43 — so the next burst
    // re-issued 43.. and every one of those failed `nonce has already been
    // used`. Reserving the block leaves the counter after it.
    expect(await resolveLatestNonce(signer, 12)).toBe(SeedNonce)
    expect(await resolveLatestNonce(signer)).toBe(SeedNonce + 12)
  })

  it("keeps blocks disjoint across concurrent reservations", async () => {
    const [first, second, third] = await Promise.all([
      resolveLatestNonce(signer, 4),
      resolveLatestNonce(signer, 3),
      resolveLatestNonce(signer, 5)
    ])
    // Whatever order they interleave in, the three blocks must not overlap.
    const blocks = [
      { first, size: 4 },
      { first: second, size: 3 },
      { first: third, size: 5 }
    ]
    const used = blocks.flatMap(({ first: start, size }) =>
      Array.from({ length: size }, (_, index) => start + index)
    )
    expect(new Set(used).size).toBe(used.length)
    expect([...used].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 12 }, (_, index) => SeedNonce + index)
    )
  })

  it("rejects a non-positive or fractional count", async () => {
    await expect(resolveLatestNonce(signer, 0)).rejects.toThrow(
      /positive integer/
    )
    await expect(resolveLatestNonce(signer, -1)).rejects.toThrow(
      /positive integer/
    )
    await expect(resolveLatestNonce(signer, 1.5)).rejects.toThrow(
      /positive integer/
    )
  })
})

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
