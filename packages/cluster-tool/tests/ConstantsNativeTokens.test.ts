import {
  EthereumNativeTokenCodename,
  NativeTokenDepotPrecision,
  SolanaNativeTokenCodename
} from "@wireio/cluster-tool-shared"
import { Constants } from "@wireio/cluster-tool/Constants"

describe("Constants — outpost native tokens", () => {
  it("aliases the shared native codenames under the harness's codename spelling", () => {
    expect(Constants.ETH_TOKEN_CODENAME).toBe(EthereumNativeTokenCodename)
    expect(Constants.SOL_TOKEN_CODENAME).toBe(SolanaNativeTokenCodename)
    expect(Constants.ETH_TOKEN_CODENAME).toBe("ETH")
    expect(Constants.SOL_TOKEN_CODENAME).toBe("SOL")
    expect(Constants.NATIVE_TOKEN_PRECISION).toBe(NativeTokenDepotPrecision)
  })

  it("pairs each outpost chain with its native asset, in the shadow-pair order", () => {
    expect(Constants.NATIVE_TOKEN_PAIRS).toEqual([
      [Constants.ETHEREUM_CHAIN_CODENAME, Constants.ETH_TOKEN_CODENAME],
      [Constants.SOLANA_CHAIN_CODENAME, Constants.SOL_TOKEN_CODENAME]
    ])
    expect(Constants.NATIVE_TOKEN_PAIRS.map(([chain]) => chain)).toEqual(
      Constants.SHADOW_LIQ_TOKEN_PAIRS.map(([chain]) => chain)
    )
  })

  it("names a chain's native asset, refusing a chain with none", () => {
    expect(Constants.nativeTokenCode(Constants.ETHEREUM_CHAIN_CODENAME)).toBe(
      "ETH"
    )
    expect(Constants.nativeTokenCode(Constants.SOLANA_CHAIN_CODENAME)).toBe(
      "SOL"
    )
    expect(() => Constants.nativeTokenCode("WIRE")).toThrow(
      /chain WIRE has no native asset/
    )
  })
})
