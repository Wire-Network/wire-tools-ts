import { TokenAmount } from "@wireio/opp-typescript-models"
import type { ChainTokenAmount } from "@wireio/cluster-tool-shared"

describe("ChainTokenAmount", () => {
  const entry: ChainTokenAmount = {
    chain_code: 2,
    amount: TokenAmount.create({ tokenCode: 7n, amount: 1_000_000n })
  }

  it("pairs a proto TokenAmount with its harness-layer chain dimension", () => {
    expect(entry.chain_code).toBe(2)
    expect(entry.amount.tokenCode).toBe(7n)
    expect(entry.amount.amount).toBe(1_000_000n)
  })

  it("round-trips the bigint amount through the proto JSON projection", () => {
    // The same projection ClusterConfigProvider.serialize/deserialize apply —
    // bigint int64s survive as strings in JSON and rehydrate losslessly.
    const rehydrated = TokenAmount.fromJson(TokenAmount.toJson(entry.amount))
    expect(rehydrated).toEqual(entry.amount)
  })
})
