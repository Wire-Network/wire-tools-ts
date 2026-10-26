import {
  EthereumReadBlockTag,
  EthereumReadConfirmationConfigSchema,
  SchemaCodec,
  createUnsetEthereumReadConfirmationConfig,
  type EthereumReadConfirmationConfig
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
})
