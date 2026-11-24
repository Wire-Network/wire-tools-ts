import { SlugName } from "@wireio/sdk-core"
import {
  describeOutpostChains,
  mapOutpostChains,
  OutpostChainCodename,
  OutpostChainCodenames
} from "@wireio/cluster-tool-shared"

describe("outpostChainCodenames", () => {
  it("names each outpost chain the way the depot registry does, value equal to key", () => {
    expect(OutpostChainCodename.ETHEREUM).toBe("ETHEREUM")
    expect(OutpostChainCodename.SOLANA).toBe("SOLANA")
    Object.entries(OutpostChainCodename).forEach(([key, value]) =>
      expect(value).toBe(key)
    )
  })

  it("lists the outpost chains in outpost order, Ethereum first, each once", () => {
    expect(OutpostChainCodenames).toEqual([
      OutpostChainCodename.ETHEREUM,
      OutpostChainCodename.SOLANA
    ])
    expect(new Set(OutpostChainCodenames).size).toBe(OutpostChainCodenames.length)
  })

  it("spells every codename as a valid slug_name, the depot's chain_code key", () => {
    OutpostChainCodenames.forEach(chain =>
      expect(SlugName.toString(SlugName.from(chain))).toBe(chain)
    )
  })

  it("mapOutpostChains keys one value per outpost chain by its codename", () => {
    const lengths = mapOutpostChains(chain => chain.length)
    expect(lengths).toEqual({
      [OutpostChainCodename.ETHEREUM]: OutpostChainCodename.ETHEREUM.length,
      [OutpostChainCodename.SOLANA]: OutpostChainCodename.SOLANA.length
    })
    expect(Object.keys(lengths)).toEqual([...OutpostChainCodenames])
  })

  it("mapOutpostChains calls the mapper once per chain, in outpost order", () => {
    const seen: string[] = []
    mapOutpostChains(chain => seen.push(chain))
    expect(seen).toEqual([...OutpostChainCodenames])
  })

  describe("describeOutpostChains", () => {
    it("lists every chain's value after its codename, in outpost order", () => {
      expect(
        describeOutpostChains({
          [OutpostChainCodename.ETHEREUM]: 4,
          [OutpostChainCodename.SOLANA]: 2
        })
      ).toBe("ETHEREUM 4, SOLANA 2")
    })

    it("prints a chain still at its genesis index as 0", () => {
      expect(
        describeOutpostChains({
          [OutpostChainCodename.ETHEREUM]: 0,
          [OutpostChainCodename.SOLANA]: 7
        })
      ).toBe("ETHEREUM 0, SOLANA 7")
    })

    it("describes each value with the given formatter, which also receives the chain", () => {
      const seen: OutpostChainCodename[] = []
      expect(
        describeOutpostChains(
          mapOutpostChains(chain => ({
            index: chain.length,
            paused: chain === OutpostChainCodename.SOLANA
          })),
          (value, chain) => {
            seen.push(chain)
            return `${value.index}${value.paused ? " (paused)" : ""}`
          }
        )
      ).toBe("ETHEREUM 8, SOLANA 6 (paused)")
      expect(seen).toEqual([...OutpostChainCodenames])
    })
  })
})
