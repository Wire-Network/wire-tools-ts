import {
  AnvilManager,
  type AnvilConfig
} from "@wireio/test-cluster-tool/processes/AnvilManager"

describe("AnvilManager", () => {
  const baseConfig: AnvilConfig = {
    host: AnvilManager.DefaultHost,
    port: AnvilManager.DefaultPort,
    chainId: AnvilManager.DefaultChainId,
    stateFile: "",
    binary: "/usr/bin/anvil",
    extraArgs: [],
    slotsInAnEpoch: 0,
    blockTimeSec: 0
  }

  it("adds Osaka gas-limit simulation args to every anvil start", () => {
    const args = AnvilManager.buildArgs(baseConfig)

    expect(args).toEqual(
      expect.arrayContaining([
        "--hardfork",
        "osaka",
        "--enable-tx-gas-limit",
        "--gas-limit",
        "60000000"
      ])
    )
  })

  it("keeps run-phase finality args alongside Osaka args", () => {
    const args = AnvilManager.buildArgs({
      ...baseConfig,
      slotsInAnEpoch: AnvilManager.SlotsInAnEpoch,
      blockTimeSec: AnvilManager.BlockTimeSec
    })

    expect(args).toEqual(
      expect.arrayContaining([
        "--slots-in-an-epoch",
        String(AnvilManager.SlotsInAnEpoch),
        "--block-time",
        String(AnvilManager.BlockTimeSec),
        "--hardfork",
        "osaka",
        "--enable-tx-gas-limit",
        "--gas-limit",
        "60000000"
      ])
    )
  })
})
