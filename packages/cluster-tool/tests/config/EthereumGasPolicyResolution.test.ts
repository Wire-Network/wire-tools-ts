import { EthereumGasPolicy } from "@wireio/cluster-tool-shared"

import {
  EthereumGasPolicyEnvVar,
  resolveEthereumGasPolicy
} from "@wireio/cluster-tool"

describe("resolveEthereumGasPolicy", () => {
  it("defaults to the stock chain when nothing selects a policy", () => {
    expect(resolveEthereumGasPolicy({})).toBe(EthereumGasPolicy.chainDefault)
  })

  it("treats an empty override as unset", () => {
    expect(
      resolveEthereumGasPolicy({ [EthereumGasPolicyEnvVar]: "" })
    ).toBe(EthereumGasPolicy.chainDefault)
  })

  it("reads each policy from the environment", () => {
    Object.values(EthereumGasPolicy).forEach(policy =>
      expect(
        resolveEthereumGasPolicy({ [EthereumGasPolicyEnvVar]: policy })
      ).toBe(policy)
    )
  })

  it("lets an explicit option win over the environment", () => {
    // Given: the environment asks for uncapped…
    const env = { [EthereumGasPolicyEnvVar]: EthereumGasPolicy.uncapped }

    // When/Then: …an explicit caller option still wins, so a scenario that
    // pins its own policy is not silently overridden by ambient env.
    expect(resolveEthereumGasPolicy(env, EthereumGasPolicy.osaka)).toBe(
      EthereumGasPolicy.osaka
    )
  })

  it("throws on an unrecognised policy rather than falling back", () => {
    // A silent fallback would run an uncapped experiment while the operator
    // believed a cap was in force — the failure must be loud.
    expect(() =>
      resolveEthereumGasPolicy({ [EthereumGasPolicyEnvVar]: "no-cap" })
    ).toThrow(/unknown policy: no-cap/)
  })
})
