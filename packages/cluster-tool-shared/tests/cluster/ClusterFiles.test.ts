import { ClusterFiles } from "@wireio/cluster-tool-shared"

describe("ClusterFiles", () => {
  it("carries the three canonical on-disk filenames", () => {
    expect(ClusterFiles.ConfigFilename).toBe("cluster-config.json")
    expect(ClusterFiles.StateFilename).toBe("cluster-state.json")
    expect(ClusterFiles.KeysFilename).toBe("cluster-keys.json")
  })

  it("carries the emitted external cluster config filename", () => {
    expect(ClusterFiles.ExternalConfigFilename).toBe(
      "external-cluster-config.json"
    )
  })

  it("carries the per-nodeop config.ini filename, distinct from the cluster JSON config", () => {
    expect(ClusterFiles.NodeConfigFilename).toBe("config.ini")
    expect(ClusterFiles.NodeConfigFilename).not.toBe(ClusterFiles.ConfigFilename)
  })
})
