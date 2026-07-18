import { ClusterFiles } from "@wireio/cluster-tool-shared"

describe("ClusterFiles", () => {
  it("carries the three canonical on-disk filenames", () => {
    expect(ClusterFiles.ConfigFilename).toBe("cluster-config.json")
    expect(ClusterFiles.StateFilename).toBe("cluster-state.json")
    expect(ClusterFiles.KeysFilename).toBe("cluster-keys.json")
  })
})
