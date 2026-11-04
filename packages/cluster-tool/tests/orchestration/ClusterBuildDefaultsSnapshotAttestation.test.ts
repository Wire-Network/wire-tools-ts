import Path from "node:path"
import { Constants } from "@wireio/cluster-tool/Constants"
import { ClusterBuildDefaults, Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import {
  fixtureExternalOutpostConfig,
  fixtureResolveEnvironment,
  type ResolveEnvironment
} from "../config/resolveEnvironmentFixture.js"
import {
  collectPhaseNames,
  collectStepNames,
  findPhase
} from "./clusterBuildFixture.js"

describe("ClusterBuildDefaults — snapshot attestation", () => {
  let environment: ResolveEnvironment, externalConfigFile: string

  beforeEach(() => {
    environment = fixtureResolveEnvironment("snapshot-attestation-")
    externalConfigFile = fixtureExternalOutpostConfig(environment.rootPath)
  })

  afterEach(() => {
    environment.cleanup()
  })

  /** Options for a LOCAL-mode build, or an EXTERNAL-mode one against already-deployed outposts. */
  function options(mode: string) {
    return {
      clusterPath: Path.join(environment.rootPath, "cluster"),
      buildPath: environment.buildPath,
      ethereumPath: "/fake/eth",
      solanaPath: "/fake/sol",
      ...(mode === "external" ? { externalOutpostConfig: externalConfigFile } : {})
    }
  }

  it.each(["local", "external"])(
    "configures it once, after sysio.system is deployed and its emissions initialised (%s mode)",
    async mode => {
      const cluster = await ClusterBuildDefaults.create(options(mode)),
        names = collectPhaseNames(cluster.children),
        steps = collectStepNames(cluster.children)
      expect(names.filter(name => name === "SnapshotAttestation")).toHaveLength(1)
      expect(steps.filter(name => name === "configure-snapshot-attestation")).toHaveLength(1)
      expect(names.indexOf("SnapshotAttestation")).toBeGreaterThan(names.indexOf("SystemContract"))
      expect(names.indexOf("SnapshotAttestation")).toBe(names.indexOf("Emissions") + 1)
      expect(names.indexOf("SnapshotAttestation")).toBeLessThan(names.indexOf("EpochBootstrap"))
    }
  )

  it.each(["local", "external"])(
    "pushes setsnpcfg as sysio with min_providers 7 and block_spacing 25000 (%s mode)",
    async mode => {
      const cluster = await ClusterBuildDefaults.create(options(mode)),
        phaseSteps = findPhase(cluster.children, "SnapshotAttestation").steps
      expect(phaseSteps).toHaveLength(1)
      const [step] = phaseSteps
      expect(step.name).toBe("configure-snapshot-attestation")
      expect(step.actor).toBe(Report.Actor.Sysio)
      expect(step.runner).toBe(Steps.contracts.sysio.system.runSetsnpcfg)
      expect(step.input).toEqual({
        kind: "SystemContractSteps.SetsnpcfgInput",
        data: {
          min_providers: Constants.SNAPSHOT_ATTESTATION_MIN_PROVIDERS,
          block_spacing: Constants.SNAPSHOT_ATTESTATION_BLOCK_SPACING
        }
      })
      expect(step.input).toEqual({
        kind: "SystemContractSteps.SetsnpcfgInput",
        data: { min_providers: 7, block_spacing: 25_000 }
      })
    }
  )
})
