import {
  createUnsetEthereumReadConfirmationConfig,
  EthereumReadBlockTag,
  MaximumUint32,
  type EthereumReadConfirmationOptions
} from "@wireio/cluster-tool-shared"

import { EthereumReadConfirmationConfigProvider } from "@wireio/cluster-tool/config"

describe("EthereumReadConfirmationConfigProvider", () => {
  describe("resolve", () => {
    it("leaves every member unset by default, so nodeop's defaults govern", () => {
      expect(EthereumReadConfirmationConfigProvider.resolve()).toEqual(
        createUnsetEthereumReadConfirmationConfig()
      )
    })

    it("keeps caller values and fills the rest with null", () => {
      expect(
        EthereumReadConfirmationConfigProvider.resolve({ confirmations: 6 })
      ).toEqual({ blockTag: null, confirmations: 6, maxFinalityLagSec: null })
      expect(
        EthereumReadConfirmationConfigProvider.resolve({
          blockTag: EthereumReadBlockTag.latest,
          confirmations: 20,
          maxFinalityLagSec: 600
        })
      ).toEqual({
        blockTag: EthereumReadBlockTag.latest,
        confirmations: 20,
        maxFinalityLagSec: 600
      })
    })

    it.each([EthereumReadBlockTag.finalized, EthereumReadBlockTag.safe])(
      "accepts the %s tag alone",
      blockTag => {
        expect(
          EthereumReadConfirmationConfigProvider.resolve({ blockTag }).blockTag
        ).toBe(blockTag)
      }
    )

    it.each([
      [EthereumReadBlockTag.finalized, { confirmations: 12 }],
      [EthereumReadBlockTag.safe, { maxFinalityLagSec: 600 }]
    ] as [EthereumReadBlockTag, EthereumReadConfirmationOptions][])(
      "refuses a depth or lag beside the %s tag, as nodeop does",
      (blockTag, member) => {
        expect(() =>
          EthereumReadConfirmationConfigProvider.resolve({ blockTag, ...member })
        ).toThrow(/applies only to the latest block tag/)
      }
    )

    it("keeps the largest uint32 nodeop parses", () => {
      expect(
        EthereumReadConfirmationConfigProvider.resolve({
          confirmations: MaximumUint32,
          maxFinalityLagSec: MaximumUint32
        })
      ).toEqual({
        blockTag: null,
        confirmations: MaximumUint32,
        maxFinalityLagSec: MaximumUint32
      })
    })

    it.each([
      { confirmations: 0 },
      { maxFinalityLagSec: -5 },
      { confirmations: 2.5 },
      { confirmations: MaximumUint32 + 1 },
      { maxFinalityLagSec: MaximumUint32 + 1 }
    ] as EthereumReadConfirmationOptions[])("refuses %o", member => {
      expect(() =>
        EthereumReadConfirmationConfigProvider.resolve(member)
      ).toThrow(/EthereumReadConfirmationConfig/)
    })
  })

  describe("toArgs", () => {
    it("renders nothing for an unset config", () => {
      expect(
        EthereumReadConfirmationConfigProvider.toArgs(
          createUnsetEthereumReadConfirmationConfig()
        )
      ).toEqual([])
    })

    it("renders one nodeop flag and value per set member, in table order", () => {
      expect(
        EthereumReadConfirmationConfigProvider.toArgs({
          blockTag: EthereumReadBlockTag.latest,
          confirmations: 20,
          maxFinalityLagSec: 600
        })
      ).toEqual([
        "--outpost-ethereum-read-block-tag",
        "latest",
        "--outpost-ethereum-read-confirmations",
        "20",
        "--outpost-ethereum-read-max-finality-lag-sec",
        "600"
      ])
      expect(
        EthereumReadConfirmationConfigProvider.toArgs({
          ...createUnsetEthereumReadConfirmationConfig(),
          blockTag: EthereumReadBlockTag.safe
        })
      ).toEqual(["--outpost-ethereum-read-block-tag", "safe"])
    })
  })
})
