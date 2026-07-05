import { SolanaOutpostBootstrapper } from "@wireio/cluster-tool/orchestration"
import { BindConfig } from "@wireio/cluster-tool/config"
import { toURL } from "@wireio/cluster-tool/utils"

describe("SolanaOutpostBootstrapper.slugNameToLittleEndianBuffer", () => {
  it("encodes a value as an 8-byte little-endian u64", () => {
    const buffer = SolanaOutpostBootstrapper.slugNameToLittleEndianBuffer(256)
    expect(buffer).toHaveLength(8)
    expect(buffer.readBigUInt64LE(0)).toBe(256n)
    expect([...buffer]).toEqual([0, 1, 0, 0, 0, 0, 0, 0])
  })

  it("round-trips an arbitrary slug code", () => {
    const buffer = SolanaOutpostBootstrapper.slugNameToLittleEndianBuffer(123_456_789)
    expect(buffer.readBigUInt64LE(0)).toBe(123_456_789n)
  })
})

describe("SolanaOutpostBootstrapper.SplReserveSpecifications", () => {
  it("provisions USDCSOL / USDTSOL / LIQSOL with the expected decimals", () => {
    const byCode = new Map(
      SolanaOutpostBootstrapper.SplReserveSpecifications.map(spec => [spec.codeName, spec])
    )
    expect(byCode.get("USDCSOL")?.decimals).toBe(6)
    expect(byCode.get("USDTSOL")?.decimals).toBe(6)
    expect(byCode.get("LIQSOL")?.decimals).toBe(9)
  })
})

describe("SolanaOutpostBootstrapper constructor", () => {
  let rpcUrl: string
  beforeAll(async () => {
    rpcUrl = toURL(await BindConfig.findAvailable(BindConfig.DefaultSolanaRpc))
  })

  it("throws when solanaPath is missing", () => {
    expect(
      () => new SolanaOutpostBootstrapper({ solanaPath: "", rpcUrl })
    ).toThrow(/solanaPath is required/)
  })

  it("throws when rpcUrl is missing", () => {
    expect(
      () => new SolanaOutpostBootstrapper({ solanaPath: "/repo/sol", rpcUrl: "" })
    ).toThrow(/rpcUrl is required/)
  })
})
