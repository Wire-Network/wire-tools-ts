import { execFileSync } from "node:child_process"
import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { ClusterPackageType } from "@wireio/cluster-tool"
import { NodeConfig } from "@wireio/cluster-tool/config"
import { getLogger } from "@wireio/cluster-tool/logging"
import { ClusterBuildContext } from "@wireio/cluster-tool/orchestration"
import { ClusterPackageSteps } from "@wireio/cluster-tool/orchestration/steps/ClusterPackageSteps"
import { Report } from "@wireio/cluster-tool/report"
import { fixtureConfig } from "../../config/clusterConfigFixture.js"

describe("ClusterPackageSteps.runPackageNode", () => {
  let dir: string
  beforeEach(() => {
    dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "clusterpkg-"))
  })
  afterEach(() => {
    Fs.rmSync(dir, { recursive: true, force: true })
  })

  it("archives a node's tree + the cluster genesis, and NEVER cluster-keys.json", async () => {
    const config = fixtureConfig({
      clusterPath: dir,
      dataPath: Path.join(dir, "data")
    })
    const node = NodeConfig.plan(config)[0] // bios (first planned node)
    expect(node).toBeDefined()

    // Materialize the node tree, the cluster genesis, and a keys file that
    // MUST be excluded from the archive.
    Fs.mkdirSync(node.nodePath, { recursive: true })
    Fs.writeFileSync(Path.join(node.nodePath, "config.ini"), "plugin = x\n")
    Fs.writeFileSync(Path.join(dir, "genesis.json"), "{}\n")
    Fs.writeFileSync(Path.join(dir, "cluster-keys.json"), "{ SECRET }\n")

    const ctx = new ClusterBuildContext(config, getLogger("pkg-test"))
    await ClusterPackageSteps.runPackageNode(
      ctx,
      {
        kind: "ClusterPackageSteps.PackageNodeInput",
        nodeName: node.name,
        packageType: ClusterPackageType.ZIP
      },
      new AbortController().signal
    )

    const zipFile = Path.join(
      dir,
      ClusterPackageSteps.PackagesSubpath,
      `${node.name}.zip`
    )
    expect(Fs.existsSync(zipFile)).toBe(true)
    expect(Fs.statSync(zipFile).size).toBeGreaterThan(0)

    const entries = execFileSync("unzip", ["-Z1", zipFile], { encoding: "utf8" })
    expect(entries).toMatch(new RegExp(`${node.name}/config\\.ini`))
    expect(entries).toMatch(/genesis\.json/)
    expect(entries).not.toMatch(/cluster-keys\.json/)
  })

  it("planPackageNode produces one archive step with a typed input", () => {
    const step = ClusterPackageSteps.planPackageNode(
      Report.Actor.Sysio,
      "package-bios",
      "archive bios",
      {},
      "bios",
      ClusterPackageType.ZIP
    )
    expect(step.input.nodeName).toBe("bios")
    expect(step.input.packageType).toBe(ClusterPackageType.ZIP)
  })
})
