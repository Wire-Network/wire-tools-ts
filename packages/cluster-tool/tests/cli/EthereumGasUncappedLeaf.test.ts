import { EthereumGasUncappedEnvVar } from "@wireio/cluster-tool"
import {
  buildOptionShape,
  flattenOptionLeaves
} from "@wireio/cluster-tool/cli/ClusterBuildOptionsArgs"

/**
 * Regression: a leaf with a STATIC default is always defined, so
 * `ClusterConfigProvider.resolve`'s "explicit option wins" branch would always
 * take it and the environment override would never be consulted. A live
 * `WIRE_ETHEREUM_GAS_POLICY=uncapped` run silently resolved to mainnet parity
 * and launched anvil with no gas flags at all — the experiment it was supposed
 * to run could not have happened.
 */
describe("ethereumGasUncapped option leaf", () => {
  const original = process.env[EthereumGasUncappedEnvVar]

  afterEach(() => {
    if (original === undefined) delete process.env[EthereumGasUncappedEnvVar]
    else process.env[EthereumGasUncappedEnvVar] = original
  })

  /** The seeded default of the flag yargs will actually expose. */
  function leafDefault(): unknown {
    const leaf = flattenOptionLeaves(buildOptionShape({})).find(
      candidate => candidate.flag === "ethereum-gas-uncapped"
    )
    expect(leaf).toBeDefined()
    return leaf?.value
  }

  it("defaults to mainnet parity with no override", () => {
    delete process.env[EthereumGasUncappedEnvVar]
    expect(leafDefault()).toBe(false)
  })

  it("tracks the environment override rather than masking it", () => {
    process.env[EthereumGasUncappedEnvVar] = "true"
    expect(leafDefault()).toBe(true)

    process.env[EthereumGasUncappedEnvVar] = "1"
    expect(leafDefault()).toBe(true)
  })

  it("does not lift the ceiling on an unrecognised override", () => {
    process.env[EthereumGasUncappedEnvVar] = "no-cap"
    expect(leafDefault()).toBe(false)
  })
})
