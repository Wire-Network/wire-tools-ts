import { ClusterPackageType } from "@wireio/cluster-tool"

describe("ClusterPackageType", () => {
  it("is an identity-mapped string enum (value === key)", () => {
    expect(ClusterPackageType.ZIP).toBe("ZIP")
  })
})
