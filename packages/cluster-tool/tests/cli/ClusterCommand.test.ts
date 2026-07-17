import { ClusterCommand } from "@wireio/cluster-tool/cli/ClusterCommand"

describe("ClusterCommand", () => {
  it("is an identity string enum (value === key) for every member", () => {
    Object.entries(ClusterCommand).forEach(([key, value]) => {
      expect(value).toBe(key)
    })
  })

  it("carries exactly the three CLI commands", () => {
    expect(Object.values(ClusterCommand).sort()).toEqual(
      ["create", "destroy", "run"].sort()
    )
  })
})
