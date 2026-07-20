import { ClusterCommand } from "@wireio/cluster-tool/cli/ClusterCommand"

describe("ClusterCommand", () => {
  it("is an identity string enum (value === key) for every member", () => {
    Object.entries(ClusterCommand).forEach(([key, value]) => {
      expect(value).toBe(key)
    })
  })

  it("carries the CLI commands (create / run / destroy / package / create-external-config)", () => {
    expect(Object.values(ClusterCommand).sort()).toEqual(
      ["create", "create-external-config", "destroy", "package", "run"].sort()
    )
  })

  it("exposes the quoted create-external-config member via bracket access", () => {
    expect(ClusterCommand["create-external-config"]).toBe("create-external-config")
  })
})
