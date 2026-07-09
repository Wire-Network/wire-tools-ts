import { ethers } from "ethers"
import {
  clearNonceCache,
  matchesProtoEnum,
  resolveLatestNonce
} from "@wireio/test-cluster-tool/util"
import { SystemContracts } from "@wireio/sdk-core"

/**
 * `matchesProtoEnum` must accept every spelling chain_plugin emits for an
 * enum table cell: the numeric value, the numeric value as a string, and
 * the proto-spelling string (which is the generated enum's member NAME).
 */
describe("matchesProtoEnum", () => {
  const Status = SystemContracts.SysioOpregOperatorstatus
  const Active = Status.OPERATOR_STATUS_ACTIVE

  it("matches the numeric representation", () => {
    expect(matchesProtoEnum(Active, Status, Active)).toBe(true)
  })

  it("matches the numeric-string representation", () => {
    expect(matchesProtoEnum(String(Active), Status, Active)).toBe(true)
  })

  it("matches the proto-spelling string representation", () => {
    expect(matchesProtoEnum("OPERATOR_STATUS_ACTIVE", Status, Active)).toBe(
      true
    )
  })

  it("rejects a different member in every representation", () => {
    const Warmup = Status.OPERATOR_STATUS_WARMUP
    expect(matchesProtoEnum(Warmup, Status, Active)).toBe(false)
    expect(matchesProtoEnum(String(Warmup), Status, Active)).toBe(false)
    expect(matchesProtoEnum("OPERATOR_STATUS_WARMUP", Status, Active)).toBe(
      false
    )
  })

  it("rejects null, undefined, and non-scalar cells", () => {
    expect(matchesProtoEnum(null, Status, Active)).toBe(false)
    expect(matchesProtoEnum(undefined, Status, Active)).toBe(false)
    expect(matchesProtoEnum({ status: Active }, Status, Active)).toBe(false)
  })

  it("works against a second generated enum (dispute status)", () => {
    const Dispute = SystemContracts.SysioChalgDisputestatus
    expect(
      matchesProtoEnum(
        "DISPUTE_STATUS_OPEN",
        Dispute,
        Dispute.DISPUTE_STATUS_OPEN
      )
    ).toBe(true)
    expect(
      matchesProtoEnum(
        Dispute.DISPUTE_STATUS_RESOLVED,
        Dispute,
        Dispute.DISPUTE_STATUS_OPEN
      )
    ).toBe(false)
  })
})

describe("resolveLatestNonce", () => {
  it("reserves a contiguous nonce block from a cached account", async () => {
    // Given: a signer whose chain nonce starts at 11.
    const address = "0x00000000000000000000000000000000000000dd",
      contract = nonceContract(address, 11)
    clearNonceCache(address)

    // When: callers reserve one nonce and then a three-nonce burst block.
    const first = await resolveLatestNonce(contract),
      burstFirst = await resolveLatestNonce(contract, 3),
      next = await resolveLatestNonce(contract)

    // Then: the cache advances by the full reserved block size.
    expect(first).toBe(11)
    expect(burstFirst).toBe(12)
    expect(next).toBe(15)
  })

  it("rejects non-positive reservation counts", async () => {
    // Given: a structurally valid signer-bound contract.
    const address = "0x00000000000000000000000000000000000000ee",
      contract = nonceContract(address, 0)
    clearNonceCache(address)

    // When / Then: reserving zero nonces is rejected before mutating the cache.
    await expect(resolveLatestNonce(contract, 0)).rejects.toThrow(
      "resolveLatestNonce: reservationCount must be a positive integer"
    )
  })
})

function nonceContract(
  address: string,
  chainNonce: number
): ethers.BaseContract {
  const runner: NonceRunner = {
    getAddress: async () => address,
    provider: new NonceProvider(chainNonce)
  }
  return new ethers.Contract(address, [], runner)
}

type NonceRunner = ethers.ContractRunner & {
  readonly getAddress: () => Promise<string>
}

class NonceProvider extends ethers.AbstractProvider {
  constructor(private readonly chainNonce: number) {
    super(ethers.Network.from(1))
  }

  override async getTransactionCount(
    _address: string,
    _blockTag?: ethers.BlockTag
  ): Promise<number> {
    return this.chainNonce
  }

  override async _detectNetwork(): Promise<ethers.Network> {
    return ethers.Network.from(1)
  }

  override async _perform<T = unknown>(
    _request: ethers.PerformActionRequest
  ): Promise<T> {
    throw new Error("NonceProvider only supports getTransactionCount")
  }
}
