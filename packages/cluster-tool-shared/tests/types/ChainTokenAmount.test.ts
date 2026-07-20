import { TokenAmount } from "@wireio/opp-typescript-models"
import {
  ChainTokenAmountSchema,
  SchemaCodec,
  type ChainTokenAmount
} from "@wireio/cluster-tool-shared"
import { z } from "zod"

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

  it("encodes the amount to its proto JSON projection (bigint → string)", () => {
    const wire = z.encode(ChainTokenAmountSchema, entry)
    expect(wire).toEqual({
      chain_code: 2,
      amount: TokenAmount.toJson(entry.amount)
    })
  })

  it("round-trips the bigint amount through the schema codec", () => {
    const codec = SchemaCodec.create<ChainTokenAmount>(ChainTokenAmountSchema)
    const rehydrated = codec.deserialize(codec.serialize(entry))
    expect(rehydrated.amount).toEqual(entry.amount)
  })

  it("check() RETURNS false on a garbage amount (never throws)", () => {
    const codec = SchemaCodec.create<ChainTokenAmount>(ChainTokenAmountSchema)
    // A malformed `amount` must fail as a zod ISSUE (the input refine), so
    // `check` returns false rather than letting `TokenAmount.fromJson` throw.
    expect(codec.check({ chain_code: 2, amount: "not-a-token-amount" })).toBe(
      false
    )
    expect(codec.check({ chain_code: 2, amount: null })).toBe(false)
  })

  it("deserialize surfaces the issue-path message on a corrupt amount", () => {
    const codec = SchemaCodec.create<ChainTokenAmount>(ChainTokenAmountSchema)
    expect(() =>
      codec.deserialize(
        JSON.stringify({ chain_code: 2, amount: { bogus: true } })
      )
    ).toThrow(/invalid TokenAmount JSON/)
  })
})
