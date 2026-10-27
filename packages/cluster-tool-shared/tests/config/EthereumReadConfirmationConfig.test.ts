import {
  EthereumReadBlockTag,
  EthereumReadConfirmationConfigSchema,
  MaximumUint32,
  SchemaCodec,
  createUnsetEthereumReadConfirmationConfig,
  type EthereumReadConfirmationConfig,
  type EthereumReadConfirmationOptions
} from "@wireio/cluster-tool-shared"

/** The persisted read confirmation's codec (it rides `ClusterConfig.ethereumRead`). */
const EthereumReadConfirmationCodec =
  SchemaCodec.create<EthereumReadConfirmationConfig>(
    EthereumReadConfirmationConfigSchema
  )

/** Every member set. */
const SetReadConfirmation: EthereumReadConfirmationConfig = {
  blockTag: EthereumReadBlockTag.latest,
  confirmations: 20,
  maxFinalityLagSec: 600
}

describe("EthereumReadBlockTag", () => {
  it("spells exactly nodeop's three readable tags", () => {
    expect(Object.values(EthereumReadBlockTag)).toEqual([
      "finalized",
      "safe",
      "latest"
    ])
  })
})

describe("EthereumReadConfirmationConfigSchema", () => {
  it("starts every member unset, leaving nodeop's defaults in force", () => {
    expect(createUnsetEthereumReadConfirmationConfig()).toEqual({
      blockTag: null,
      confirmations: null,
      maxFinalityLagSec: null
    })
    expect(
      EthereumReadConfirmationConfigSchema.safeParse(
        createUnsetEthereumReadConfirmationConfig()
      ).success
    ).toBe(true)
  })

  it("round-trips a fully set config", () => {
    expect(
      EthereumReadConfirmationCodec.deserialize(
        EthereumReadConfirmationCodec.serialize(SetReadConfirmation)
      )
    ).toEqual(SetReadConfirmation)
  })

  it.each([
    { blockTag: "pending" },
    { confirmations: 0 },
    { confirmations: 1.5 },
    { maxFinalityLagSec: -1 }
  ])("rejects %o", member => {
    expect(
      EthereumReadConfirmationConfigSchema.safeParse({
        ...createUnsetEthereumReadConfirmationConfig(),
        ...member
      }).success
    ).toBe(false)
  })

  it.each([
    { confirmations: MaximumUint32 },
    { maxFinalityLagSec: MaximumUint32 }
  ] as EthereumReadConfirmationOptions[])(
    "accepts the largest uint32 nodeop parses, %o",
    member => {
      expect(
        EthereumReadConfirmationConfigSchema.safeParse({
          ...createUnsetEthereumReadConfirmationConfig(),
          ...member
        }).success
      ).toBe(true)
    }
  )

  it.each([
    { confirmations: MaximumUint32 + 1 },
    { maxFinalityLagSec: MaximumUint32 + 1 }
  ] as EthereumReadConfirmationOptions[])(
    "rejects one past the largest uint32, %o, which nodeop refuses",
    member => {
      expect(
        EthereumReadConfirmationConfigSchema.safeParse({
          ...createUnsetEthereumReadConfirmationConfig(),
          ...member
        }).success
      ).toBe(false)
    }
  )

  it.each([
    { blockTag: null, confirmations: 6, maxFinalityLagSec: 600 },
    {
      blockTag: EthereumReadBlockTag.latest,
      confirmations: 6,
      maxFinalityLagSec: 600
    }
  ] as EthereumReadConfirmationConfig[])(
    "accepts a depth and lag with nodeop's latest tag, %o",
    config => {
      expect(EthereumReadConfirmationConfigSchema.safeParse(config).success).toBe(
        true
      )
    }
  )

  it.each([
    [EthereumReadBlockTag.finalized, "confirmations"],
    [EthereumReadBlockTag.safe, "maxFinalityLagSec"]
  ] as [EthereumReadBlockTag, keyof EthereumReadConfirmationConfig][])(
    "rejects a depth or lag beside the %s tag, naming %s",
    (blockTag, member) => {
      const parsed = EthereumReadConfirmationConfigSchema.safeParse({
        ...createUnsetEthereumReadConfirmationConfig(),
        blockTag,
        [member]: 12
      })
      expect(parsed.success).toBe(false)
      expect(parsed.error.issues).toEqual([
        expect.objectContaining({
          path: [member],
          message: `${member} applies only to the ${EthereumReadBlockTag.latest} block tag, not ${blockTag}`
        })
      ])
    }
  )

  it("refuses to deserialize a persisted depth beside a non-latest tag", () => {
    expect(() =>
      EthereumReadConfirmationCodec.deserialize(
        JSON.stringify({
          blockTag: EthereumReadBlockTag.safe,
          confirmations: 12,
          maxFinalityLagSec: null
        })
      )
    ).toThrow(/applies only to the latest block tag/)
  })
})
