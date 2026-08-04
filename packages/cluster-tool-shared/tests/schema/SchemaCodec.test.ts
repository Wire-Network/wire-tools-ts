import { TokenAmount } from "@wireio/opp-typescript-models"
import {
  ChainTokenAmountSchema,
  SchemaCodec,
  type ChainTokenAmount
} from "@wireio/cluster-tool-shared"
import { z } from "zod"

const PersonSchema = z.object({
  name: z.string(),
  age: z.number().int().nonnegative()
})
type Person = z.infer<typeof PersonSchema>
const PersonSchemaCodec = SchemaCodec.create<Person>(PersonSchema)

describe("SchemaCodec", () => {
  describe("plain schema (no codec field)", () => {
    const person: Person = { name: "ada", age: 36 }

    it("round-trips serialize → deserialize", () => {
      const text = PersonSchemaCodec.serialize(person)
      expect(PersonSchemaCodec.deserialize(text)).toEqual(person)
    })

    it("pretty-prints with the shared indent width", () => {
      expect(PersonSchemaCodec.serialize(person)).toBe(
        JSON.stringify(person, null, SchemaCodec.SerializeIndent)
      )
    })

    it("deserializes from UTF-8 bytes", () => {
      const bytes = new TextEncoder().encode(PersonSchemaCodec.serialize(person))
      expect(PersonSchemaCodec.deserialize(bytes)).toEqual(person)
    })

    it("throws on invalid JSON text", () => {
      expect(() => PersonSchemaCodec.deserialize("{not json")).toThrow(
        /invalid JSON/
      )
    })

    it("throws carrying the offending field path on a shape violation", () => {
      expect(() =>
        PersonSchemaCodec.deserialize(JSON.stringify({ name: "ada", age: -1 }))
      ).toThrow(/age/)
    })

    it("check() narrows a valid value and rejects an invalid one", () => {
      expect(PersonSchemaCodec.check(person)).toBe(true)
      expect(PersonSchemaCodec.check({ name: "ada" })).toBe(false)
      expect(PersonSchemaCodec.check(null)).toBe(false)
    })
  })

  describe("codec-bearing schema (ChainTokenAmount bigint bridge)", () => {
    const ChainTokenAmountSchemaCodec =
      SchemaCodec.create<ChainTokenAmount>(ChainTokenAmountSchema)
    const entry: ChainTokenAmount = {
      chain_code: 2,
      amount: TokenAmount.create({ tokenCode: 7n, amount: 1_000_000n })
    }

    it("serialize projects the bigint amount through TokenAmount.toJson", () => {
      const text = ChainTokenAmountSchemaCodec.serialize(entry)
      const parsed = JSON.parse(text)
      expect(parsed.chain_code).toBe(2)
      expect(parsed.amount).toEqual(TokenAmount.toJson(entry.amount))
    })

    it("deserialize rehydrates the bigint amount losslessly", () => {
      const text = ChainTokenAmountSchemaCodec.serialize(entry)
      const rehydrated = ChainTokenAmountSchemaCodec.deserialize(text)
      expect(rehydrated.chain_code).toBe(2)
      expect(rehydrated.amount.tokenCode).toBe(7n)
      expect(rehydrated.amount.amount).toBe(1_000_000n)
    })
  })
})
