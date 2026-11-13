import { ClusterCommand } from "@wireio/cluster-tool/cli/ClusterCommand"

describe("ClusterCommand", () => {
  it("is an identity string enum (value === key) for every member", () => {
    Object.entries(ClusterCommand).forEach(([key, value]) => {
      expect(value).toBe(key)
    })
  })

  it("carries the CLI commands (create / run / destroy / package / create-external-config / create-api-node / create-batch-operator-keys / fund-batch-operators)", () => {
    expect(Object.values(ClusterCommand).sort()).toEqual(
      [
        "create",
        "create-api-node",
        "create-batch-operator-keys",
        "create-external-config",
        "destroy",
        "fund-batch-operators",
        "package",
        "run"
      ].sort()
    )
  })

  it("exposes the quoted create-external-config member via bracket access", () => {
    expect(ClusterCommand["create-external-config"]).toBe("create-external-config")
  })

  it("exposes the quoted create-api-node member via bracket access", () => {
    expect(ClusterCommand["create-api-node"]).toBe("create-api-node")
  })

  it("exposes the quoted create-batch-operator-keys member via bracket access", () => {
    expect(ClusterCommand["create-batch-operator-keys"]).toBe(
      "create-batch-operator-keys"
    )
  })

  it("exposes the quoted fund-batch-operators member via bracket access", () => {
    expect(ClusterCommand["fund-batch-operators"]).toBe("fund-batch-operators")
  })
})
