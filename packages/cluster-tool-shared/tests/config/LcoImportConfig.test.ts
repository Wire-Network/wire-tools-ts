import {
  LcoImportConfigSchema,
  LcoImportOptionsSchema,
  LcoImportUsdPriceDecimals,
  LiqPoolSpecCodec
} from "@wireio/cluster-tool-shared"
import { LiqPoolSpec } from "@wireio/opp-typescript-models"

describe("LcoImportConfig", () => {
  it("prices in USD with 8 decimals", () => {
    expect(LcoImportUsdPriceDecimals).toBe(8)
  })

  it("defaults every pricing member of a chain to null and an absent chain to null", () => {
    const config = LcoImportConfigSchema.parse({
      solana: { bootstrapJsonFile: "/inputs/solana.json" }
    })
    expect(config.ethereum).toBeNull()
    expect(config.solana).toEqual({
      bootstrapJsonFile: "/inputs/solana.json",
      nativePriceUsd: null,
      highestTranchePriceUsd: null,
      pool: null
    })
    expect(config.dclaimFundingAccount).toBeNull()
  })

  it("decodes pool tuning through the generated LiqPoolSpec, proto field names included", () => {
    const pool = LiqPoolSpecCodec.parse({
      fee: 30,
      conversion_horizon_sec: 86_400,
      depthCapBps: 50,
      clipFloor: "1000"
    })
    expect(pool).toEqual(
      LiqPoolSpec.create({
        fee: 30,
        conversionHorizonSec: 86_400,
        depthCapBps: 50,
        clipFloor: 1_000n
      })
    )
  })

  it("rejects pool JSON the proto does not accept", () => {
    expect(LiqPoolSpecCodec.safeParse({ fee: "thirty" }).success).toBe(false)
    expect(LiqPoolSpecCodec.safeParse({ notAField: 1 }).success).toBe(false)
  })

  it("takes caller pricing per chain with no export path", () => {
    const options = LcoImportOptionsSchema.parse({
      ethereum: { nativePriceUsd: "400000000000" },
      dclaimFundingAccount: "sysio"
    })
    expect(options.ethereum.nativePriceUsd).toBe("400000000000")
    expect(options.solana).toBeUndefined()
    expect(
      LcoImportOptionsSchema.safeParse({
        ethereum: { nativePriceUsd: "4000.5" }
      }).success
    ).toBe(false)
  })

  it("rejects a misspelled member at either level instead of dropping it", () => {
    const unrecognized = (options: object) =>
      LcoImportOptionsSchema.safeParse(options).error?.issues.map(issue => [
        issue.code,
        issue.path
      ])
    expect(unrecognized({ dclaimFundingAcount: "sysio" })).toEqual([
      ["unrecognized_keys", []]
    ])
    expect(unrecognized({ solana: { nativePriceUSD: "20000000000" } })).toEqual(
      [["unrecognized_keys", ["solana"]]]
    )
    expect(
      unrecognized({ ethereum: { bootstrapJsonFile: "/inputs/ethereum.json" } })
    ).toEqual([["unrecognized_keys", ["ethereum"]]])
  })
})
