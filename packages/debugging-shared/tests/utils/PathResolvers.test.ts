import * as Path from "node:path"

import {
  ClusterSubpath,
  isPathUnder,
  oppDebuggingPath
} from "@wireio/debugging-shared"

describe("ClusterSubpath", () => {
  it("OppDebugging is data/opp-debugging", () => {
    expect(ClusterSubpath.OppDebugging).toBe(Path.join("data", "opp-debugging"))
  })
})

describe("oppDebuggingPath", () => {
  it("joins clusterPath with the OPP debugging subpath", () => {
    expect(oppDebuggingPath("/tmp/cluster")).toBe(
      Path.join("/tmp/cluster", "data", "opp-debugging")
    )
  })
})

describe("isPathUnder", () => {
  it("accepts the root itself", () => {
    expect(isPathUnder("/var/cluster", "/var/cluster")).toBe(true)
  })

  it("accepts a path strictly under the root", () => {
    expect(isPathUnder("/var/cluster/data/log", "/var/cluster")).toBe(true)
  })

  it("rejects a sibling path with a matching prefix", () => {
    expect(isPathUnder("/var/cluster-other", "/var/cluster")).toBe(false)
  })

  it("rejects a path outside the root", () => {
    expect(isPathUnder("/etc/passwd", "/var/cluster")).toBe(false)
  })

  it("rejects relative-traversal paths after resolution", () => {
    expect(isPathUnder("/var/cluster/../etc", "/var/cluster")).toBe(false)
  })
})
