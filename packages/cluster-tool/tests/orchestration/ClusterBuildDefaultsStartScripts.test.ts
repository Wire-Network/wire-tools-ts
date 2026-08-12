import Path from "node:path"
import { DaemonConfig } from "@wireio/cluster-tool/config"
import { ClusterBuildDefaults } from "@wireio/cluster-tool/orchestration"
import {
  fixtureResolveEnvironment,
  type ResolveEnvironment
} from "../config/resolveEnvironmentFixture.js"

import { collectPhaseNames, collectStepNames } from "./clusterBuildFixture.js"

describe("ClusterBuildDefaults — start-script composition", () => {
  let environment: ResolveEnvironment

  beforeEach(() => {
    environment = fixtureResolveEnvironment("start-scripts-")
  })

  afterEach(() => {
    environment.cleanup()
  })

  function baseOptions() {
    return {
      clusterPath: Path.join(environment.rootPath, "cluster"),
      buildPath: environment.buildPath,
      ethereumPath: "/fake/eth",
      solanaPath: "/fake/sol"
    }
  }

  /** The bundle-copy step's name, as `planStartScripts` registers it. */
  const CopyStepName = "copy-debugging-server-bundle"

  it("registers the StartScripts phase for a default cluster", async () => {
    const cluster = await ClusterBuildDefaults.create(baseOptions())
    expect(collectPhaseNames(cluster.children)).toContain("StartScripts")
  })

  it("copies the bundle EXACTLY when the debugging server is enumerated", async () => {
    // The copy gate and the emit enumeration must be ONE predicate. They were
    // two: the gate re-derived `config.debuggingServerEnabled !== false` while
    // the labels came from `plannedLabels`. Nothing failed — until a condition
    // is added to `plannedLabels` that the copy gate never learns, at which
    // point `debugging_server/start.sh` is emitted for a bundle nobody copied
    // and the script execs a missing file. `assertBundlePresent` cannot catch
    // that: it runs INSIDE the copy step that didn't run.
    const cluster = await ClusterBuildDefaults.create(baseOptions()),
      labels = DaemonConfig.plannedLabels(cluster.config),
      steps = collectStepNames(cluster.children)
    expect(steps.includes(CopyStepName)).toBe(
      labels.includes(DaemonConfig.DebuggingServerSubpath)
    )
  })

  // The DISABLED half is not asserted here on purpose: `debuggingServerEnabled`
  // is a persisted ClusterConfig field (default true) that only
  // `create-external-config --no-debugging-server` flips — it is NOT a
  // ClusterBuildOptions leaf, so `create()` cannot reach that state and a test
  // claiming to exercise it would be testing a path that does not exist.
  // `DaemonConfig.test.ts` covers `plannedLabels`' side of the gate directly.
})
