import {
  EthereumNativeTokenCodename,
  NativeTokenCodenames,
  NativeTokenDepotPrecision,
  SolanaNativeTokenCodename
} from "@wireio/cluster-tool-shared"

describe("nativeTokenCodenames", () => {
  it("names each outpost's native asset the way the depot registry does", () => {
    expect(EthereumNativeTokenCodename).toBe("ETH")
    expect(SolanaNativeTokenCodename).toBe("SOL")
  })

  it("lists the native codenames in outpost order, Ethereum first", () => {
    expect(NativeTokenCodenames).toEqual([
      EthereumNativeTokenCodename,
      SolanaNativeTokenCodename
    ])
    // A closed roster: the pre-funding amounts name exactly these.
    expect(new Set(NativeTokenCodenames).size).toBe(NativeTokenCodenames.length)
  })

  it("registers native tokens at 9 depot decimals (regtoken precision 9)", () => {
    expect(NativeTokenDepotPrecision).toBe(9)
  })
})
