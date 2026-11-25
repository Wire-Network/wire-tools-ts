import { TokenAmount } from "@wireio/opp-typescript-models"
import { SlugName } from "@wireio/sdk-core"
import {
  BatchOperatorUnderwritingConfig,
  BatchOperatorUnderwritingConfigSchema,
  EthereumNativeTokenCodename,
  SchemaCodec,
  SolanaNativeTokenCodename,
  type BatchOperatorUnderwritingOptions
} from "@wireio/cluster-tool-shared"

/** The packed depot code of a token codename. */
const tokenCode = (codename: string): bigint => BigInt(SlugName.from(codename))

/** A cap row the schema requires at least one of. */
const Cap = TokenAmount.toJson(
  TokenAmount.create({ tokenCode: tokenCode("LIQSOL"), amount: 10_000_000_000n })
)

describe("BatchOperatorUnderwritingConfig", () => {
  describe("defaults", () => {
    it("stakes 1 ETH + 10 SOL and keeps 0.05 ETH + 0.1 SOL, in depot units, Ethereum first", () => {
      expect(BatchOperatorUnderwritingConfig.DefaultStakeEthereumUnits).toBe(
        1_000_000_000n
      )
      expect(BatchOperatorUnderwritingConfig.DefaultStakeSolanaUnits).toBe(
        10_000_000_000n
      )
      expect(BatchOperatorUnderwritingConfig.DefaultReserveEthereumUnits).toBe(
        50_000_000n
      )
      expect(BatchOperatorUnderwritingConfig.DefaultReserveSolanaUnits).toBe(
        100_000_000n
      )
      expect(
        BatchOperatorUnderwritingConfig.DefaultStake.map(amount => [
          SlugName.toString(Number(amount.tokenCode)),
          amount.amount
        ])
      ).toEqual([
        [EthereumNativeTokenCodename, 1_000_000_000n],
        [SolanaNativeTokenCodename, 10_000_000_000n]
      ])
      expect(
        BatchOperatorUnderwritingConfig.DefaultReserve.map(amount => [
          SlugName.toString(Number(amount.tokenCode)),
          amount.amount
        ])
      ).toEqual([
        [EthereumNativeTokenCodename, 50_000_000n],
        [SolanaNativeTokenCodename, 100_000_000n]
      ])
    })

    it("adds 2500 bps (+25%) of gas headroom to every Ethereum funding write", () => {
      expect(BatchOperatorUnderwritingConfig.DefaultGasDriftMarginBps).toBe(2_500)
    })

    it("nativeTokenAmount packs the codename as the depot's slug code", () => {
      const amount = BatchOperatorUnderwritingConfig.nativeTokenAmount(
        EthereumNativeTokenCodename,
        7n
      )
      expect(amount.tokenCode).toBe(tokenCode(EthereumNativeTokenCodename))
      expect(amount.amount).toBe(7n)
    })

    it("defaultStake / defaultReserve hand out FRESH copies, never the shared constants", () => {
      const stake = BatchOperatorUnderwritingConfig.defaultStake(),
        reserve = BatchOperatorUnderwritingConfig.defaultReserve()
      expect(stake).toEqual(BatchOperatorUnderwritingConfig.DefaultStake)
      expect(reserve).toEqual(BatchOperatorUnderwritingConfig.DefaultReserve)
      stake.forEach((amount, index) =>
        expect(amount).not.toBe(BatchOperatorUnderwritingConfig.DefaultStake[index])
      )
      reserve.forEach((amount, index) =>
        expect(amount).not.toBe(
          BatchOperatorUnderwritingConfig.DefaultReserve[index]
        )
      )
      expect(BatchOperatorUnderwritingConfig.defaultStake()).not.toBe(stake)
    })
  })

  describe("schema", () => {
    it("fills stake + reserve from the defaults when a config omits them (every existing fixture keeps validating)", () => {
      const parsed = BatchOperatorUnderwritingConfigSchema.parse({
        fundedOperatorCount: 1,
        maxExposure: [Cap]
      })
      expect(parsed.fundedOperatorCount).toBe(1)
      expect(parsed.stake).toEqual(BatchOperatorUnderwritingConfig.DefaultStake)
      expect(parsed.reserve).toEqual(
        BatchOperatorUnderwritingConfig.DefaultReserve
      )
      // The parse decodes to live TokenAmounts, bigint amounts intact.
      expect(typeof parsed.stake[0].amount).toBe("bigint")
      // …and never aliases the shared constant.
      expect(parsed.stake[0]).not.toBe(
        BatchOperatorUnderwritingConfig.DefaultStake[0]
      )
    })

    it("fills the defaults for an explicitly undefined member too", () => {
      const parsed = BatchOperatorUnderwritingConfigSchema.parse({
        fundedOperatorCount: 1,
        maxExposure: [Cap],
        stake: undefined,
        reserve: undefined
      })
      expect(parsed.stake).toHaveLength(2)
      expect(parsed.reserve).toHaveLength(2)
    })

    it("decodes a set stake / reserve through the TokenAmount codec", () => {
      const parsed = BatchOperatorUnderwritingConfigSchema.parse({
        fundedOperatorCount: 2,
        maxExposure: [Cap],
        stake: [
          TokenAmount.toJson(
            TokenAmount.create({
              tokenCode: tokenCode(EthereumNativeTokenCodename),
              amount: 250_000_000n
            })
          )
        ],
        reserve: []
      })
      expect(parsed.stake).toHaveLength(1)
      expect(parsed.stake[0].amount).toBe(250_000_000n)
      expect(parsed.reserve).toEqual([])
    })

    it("fills gasDriftMarginBps with the default when a config omits it, or sets it undefined", () => {
      expect(
        BatchOperatorUnderwritingConfigSchema.parse({
          fundedOperatorCount: 1,
          maxExposure: [Cap]
        }).gasDriftMarginBps
      ).toBe(BatchOperatorUnderwritingConfig.DefaultGasDriftMarginBps)
      expect(
        BatchOperatorUnderwritingConfigSchema.parse({
          fundedOperatorCount: 1,
          maxExposure: [Cap],
          gasDriftMarginBps: undefined
        }).gasDriftMarginBps
      ).toBe(BatchOperatorUnderwritingConfig.DefaultGasDriftMarginBps)
    })

    it("parses an explicit gasDriftMarginBps, zero included", () => {
      expect(
        BatchOperatorUnderwritingConfigSchema.parse({
          fundedOperatorCount: 1,
          maxExposure: [Cap],
          gasDriftMarginBps: 1_000
        }).gasDriftMarginBps
      ).toBe(1_000)
      expect(
        BatchOperatorUnderwritingConfigSchema.parse({
          fundedOperatorCount: 1,
          maxExposure: [Cap],
          gasDriftMarginBps: 0
        }).gasDriftMarginBps
      ).toBe(0)
    })

    it("rejects a negative, fractional or non-numeric gasDriftMarginBps", () => {
      const marginParses = (gasDriftMarginBps: unknown): boolean =>
        BatchOperatorUnderwritingConfigSchema.safeParse({
          fundedOperatorCount: 1,
          maxExposure: [Cap],
          gasDriftMarginBps
        }).success
      expect(marginParses(-1)).toBe(false)
      expect(marginParses(2.5)).toBe(false)
      expect(marginParses("2500")).toBe(false)
    })

    it("rejects a malformed stake entry as a zod issue, never a raw proto error", () => {
      const result = BatchOperatorUnderwritingConfigSchema.safeParse({
        fundedOperatorCount: 1,
        maxExposure: [Cap],
        stake: [{ tokenCode: "not-a-number", amount: "1" }]
      })
      expect(result.success).toBe(false)
    })

    it("keeps the members optional on the inferred type so an in-memory config may omit them", () => {
      // Type-level: an options literal without the two members compiles.
      const options: BatchOperatorUnderwritingOptions = { fundedOperatorCount: 1 }
      expect(options.stake).toBeUndefined()
      expect(options.reserve).toBeUndefined()
      expect(options.gasDriftMarginBps).toBeUndefined()
    })

    it("round-trips through the codec with the defaults persisted and bigints intact", () => {
      const codec = SchemaCodec.create<
          ReturnType<typeof BatchOperatorUnderwritingConfigSchema.parse>
        >(BatchOperatorUnderwritingConfigSchema),
        parsed = BatchOperatorUnderwritingConfigSchema.parse({
          fundedOperatorCount: 1,
          maxExposure: [Cap]
        }),
        text = codec.serialize(parsed),
        reloaded = codec.deserialize(text)
      expect(JSON.parse(text).stake).toHaveLength(2)
      expect(JSON.parse(text).reserve).toHaveLength(2)
      expect(JSON.parse(text).gasDriftMarginBps).toBe(
        BatchOperatorUnderwritingConfig.DefaultGasDriftMarginBps
      )
      expect(reloaded.gasDriftMarginBps).toBe(
        BatchOperatorUnderwritingConfig.DefaultGasDriftMarginBps
      )
      expect(reloaded.stake[1].amount).toBe(
        BatchOperatorUnderwritingConfig.DefaultStakeSolanaUnits
      )
      expect(reloaded.reserve[0].tokenCode).toBe(
        tokenCode(EthereumNativeTokenCodename)
      )
    })

    it("still refuses an underwriting config with no exposure cap", () => {
      expect(
        BatchOperatorUnderwritingConfigSchema.safeParse({
          fundedOperatorCount: 1,
          maxExposure: []
        }).success
      ).toBe(false)
    })
  })
})
