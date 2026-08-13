import { EthereumGasPolicy } from "@wireio/cluster-tool-shared"

import { EthereumGasPolicyEnvVar } from "@wireio/cluster-tool"
import {
  buildOptionShape,
  flattenOptionLeaves
} from "@wireio/cluster-tool/cli/ClusterBuildOptionsArgs"

/**
 * Regression: a leaf with a STATIC default is always defined, so
 * `ClusterConfigProvider.resolve`'s "explicit option wins" branch would always
 * take it and the environment override would never be consulted. A live
 * `WIRE_ETHEREUM_GAS_POLICY=uncapped` run silently resolved to `mainnetParity`
 * and launched anvil with no gas flags at all — the experiment it was supposed
 * to run could not have happened.
 */
describe("ethereumGasPolicy option leaf", () => {
  const original = process.env[EthereumGasPolicyEnvVar]

  afterEach(() => {
    if (original === undefined) delete process.env[EthereumGasPolicyEnvVar]
    else process.env[EthereumGasPolicyEnvVar] = original
  })

  /** The seeded default of the flag yargs will actually expose. */
  function leafDefault(): unknown {
    const leaf = flattenOptionLeaves(buildOptionShape({})).find(
      candidate => candidate.flag === "ethereum-gas-policy"
    )
    expect(leaf).toBeDefined()
    return leaf?.value
  }

  it("defaults to the stock chain with no override", () => {
    delete process.env[EthereumGasPolicyEnvVar]
    expect(leafDefault()).toBe(EthereumGasPolicy.mainnetParity)
  })

  it("tracks the environment override rather than masking it", () => {
    process.env[EthereumGasPolicyEnvVar] = EthereumGasPolicy.uncapped
    expect(leafDefault()).toBe(EthereumGasPolicy.uncapped)

    process.env[EthereumGasPolicyEnvVar] = EthereumGasPolicy.uncapped
    expect(leafDefault()).toBe(EthereumGasPolicy.uncapped)
  })

  it("rejects an unrecognised override at shape-build time", () => {
    process.env[EthereumGasPolicyEnvVar] = "no-cap"
    expect(() => leafDefault()).toThrow(/unknown policy: no-cap/)
  })
})
