import {
  EthereumGasUncappedEnvVar,
  resolveEthereumGasUncapped
} from "@wireio/cluster-tool"

describe("resolveEthereumGasUncapped", () => {
  it("defaults to mainnet parity with no override", () => {
    expect(resolveEthereumGasUncapped({})).toBe(false)
  })

  it("treats an empty value as unset", () => {
    expect(
      resolveEthereumGasUncapped({ [EthereumGasUncappedEnvVar]: "" })
    ).toBe(false)
  })

  it("accepts the documented truthy spellings, case-insensitively", () => {
    ;["1", "true", "TRUE", "Yes", " yes "].forEach(value =>
      expect(
        resolveEthereumGasUncapped({ [EthereumGasUncappedEnvVar]: value })
      ).toBe(true)
    )
  })

  it("does NOT lift the ceiling on an unrecognised value", () => {
    // Silently enabling an unrealistic gas regime would make a run look like
    // it proved something about mainnet when it proves nothing.
    ;["0", "false", "no", "uncapped", "osaka", "maybe"].forEach(value =>
      expect(
        resolveEthereumGasUncapped({ [EthereumGasUncappedEnvVar]: value })
      ).toBe(false)
    )
  })

  it("lets an explicit option win over the environment", () => {
    const env = { [EthereumGasUncappedEnvVar]: "true" }
    expect(resolveEthereumGasUncapped(env, false)).toBe(false)
    expect(resolveEthereumGasUncapped({}, true)).toBe(true)
  })
})
