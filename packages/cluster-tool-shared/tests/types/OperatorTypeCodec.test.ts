import { OperatorType } from "@wireio/opp-typescript-models"
import { OperatorTypeCodec, SchemaCodec } from "@wireio/cluster-tool-shared"
import { z } from "zod"

/** The OPP operator types a bootstrap roster admits — a strict subset of the enum. */
const RosterTypes: readonly OperatorType[] = [
  OperatorType.PRODUCER,
  OperatorType.BATCH,
  OperatorType.UNDERWRITER
]

describe("OperatorTypeCodec", () => {
  it("Members lists every numeric OperatorType member in declaration order", () => {
    expect(OperatorTypeCodec.Members).toEqual([
      OperatorType.UNKNOWN,
      OperatorType.PRODUCER,
      OperatorType.BATCH,
      OperatorType.UNDERWRITER,
      OperatorType.CHALLENGER
    ])
  })

  it("decodes a member NAME to the numeric enum and encodes it back", () => {
    const codec = OperatorTypeCodec.create()
    expect(z.decode(codec, "BATCH")).toBe(OperatorType.BATCH)
    expect(z.encode(codec, OperatorType.UNDERWRITER)).toBe("UNDERWRITER")
  })

  it("rejects an unknown name", () => {
    expect(OperatorTypeCodec.create().safeParse("BOGUS").success).toBe(false)
  })

  it("a subset codec rejects a non-admitted name on decode and a non-admitted value on encode", () => {
    const codec = OperatorTypeCodec.create(RosterTypes)
    expect(codec.safeParse("PRODUCER").success).toBe(true)
    expect(codec.safeParse("CHALLENGER").success).toBe(false)
    expect(z.safeEncode(codec, OperatorType.CHALLENGER).success).toBe(false)
    expect(z.safeEncode(codec, OperatorType.BATCH).success).toBe(true)
  })

  it("throws when no member is admitted", () => {
    expect(() => OperatorTypeCodec.create([])).toThrow(/at least one member/)
  })

  it("projects to a JSON Schema enum of exactly the admitted names", () => {
    const schema = SchemaCodec.create<OperatorType>(
      OperatorTypeCodec.create(RosterTypes)
    ).toJSONSchema()
    expect(schema.enum).toEqual(["PRODUCER", "BATCH", "UNDERWRITER"])
  })
})
