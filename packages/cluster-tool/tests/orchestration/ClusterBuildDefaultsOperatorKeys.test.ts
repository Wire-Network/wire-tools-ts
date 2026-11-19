import Path from "node:path"
import { OperatorType } from "@wireio/opp-typescript-models"
import { Constants } from "@wireio/cluster-tool/Constants"
import {
  ClusterBuildDefaults,
  type StepInput
} from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { WireOperatorProvisioningTool } from "@wireio/cluster-tool/tools/wire"
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

/** The phase that materializes every bootstrapped batch operator's identity. */
const OperatorKeysPhase = "OperatorKeys"
/** The phases it must sit between. */
const ProducerIdentitiesPhase = "ProducerIdentities"
const BiosNodePhase = "BiosNode"
const EthereumOutpostPhase = "EthereumOutpost"
/** One operator's identity step and provisioning phase, by label. */
const identityStepName = (label: string) => `${label}-identity`
const provisionPhaseName = (label: string) => `Provision ${label}`

describe("ClusterBuildDefaults — OperatorKeys phase", () => {
  let environment: ResolveEnvironment

  beforeEach(() => {
    environment = fixtureResolveEnvironment("operator-keys-")
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

  it("materializes the batch operators right after ProducerIdentities, before any node starts and before the Ethereum outpost deploys", async () => {
    // Pure key work with the same earliest-possible point as the producers':
    // the Ethereum deploy seats a provisional roster of these operators' ETH
    // addresses, and no address exists ahead of its random key.
    const cluster = await ClusterBuildDefaults.create(baseOptions()),
      phases = collectPhaseNames(cluster.children)
    expect(phases.indexOf(OperatorKeysPhase)).toBe(
      phases.indexOf(ProducerIdentitiesPhase) + 1
    )
    expect(phases.indexOf(OperatorKeysPhase)).toBeLessThan(
      phases.indexOf(BiosNodePhase)
    )
    expect(phases.indexOf(OperatorKeysPhase)).toBeLessThan(
      phases.indexOf(EthereumOutpostPhase)
    )
  })

  it("plans ONE identity step per bootstrapped batch operator, in label order, as the batch-operator actor", async () => {
    const cluster = await ClusterBuildDefaults.create(baseOptions()),
      labels = Constants.batchOperatorLabels(
        cluster.context.config.batchOperatorCount
      ),
      phase = findPhase(cluster.children, OperatorKeysPhase)
    expect(labels.length).toBeGreaterThan(0)
    expect(phase.steps.map(step => step.name)).toEqual(
      labels.map(identityStepName)
    )
    expect(phase.steps.map(step => step.input)).toEqual(
      labels.map(label => ({
        kind: "WireOperatorProvisioningTool.MaterializeIdentityInput",
        label,
        type: OperatorType.BATCH
      }))
    )
    phase.steps.forEach(step => {
      expect(step.actor).toBe(Report.Actor.BatchOperator)
      expect(step.runner).toBe(
        WireOperatorProvisioningTool.runIdentityMaterialization
      )
    })
  })

  it("materializes each identity exactly ONCE — the provisioning phases carry identityMaterialized and plan no second step", async () => {
    const cluster = await ClusterBuildDefaults.create(baseOptions()),
      labels = Constants.batchOperatorLabels(
        cluster.context.config.batchOperatorCount
      ),
      names = collectStepNames(cluster.children)
    labels.forEach(label => {
      expect(names.filter(name => name === identityStepName(label))).toHaveLength(1)
      const provisioning = findPhase(cluster.children, provisionPhaseName(label))
      expect(
        provisioning.steps.map(step => (step.input as StepInput).kind)
      ).not.toContain("WireOperatorProvisioningTool.MaterializeIdentityInput")
      // The identity precedes its provisioning, which reads the stored keys.
      expect(names.indexOf(identityStepName(label))).toBeLessThan(
        names.indexOf(`${label}-account`)
      )
    })
  })

  it("keeps OperatorKeys in external-outpost mode — a real chain needs the daemons' keys all the same", async () => {
    const cluster = await ClusterBuildDefaults.create({
        ...baseOptions(),
        externalOutpostConfig: fixtureExternalOutpostConfig(environment.rootPath)
      }),
      phases = collectPhaseNames(cluster.children)
    expect(phases).toContain(OperatorKeysPhase)
    expect(phases.indexOf(OperatorKeysPhase)).toBe(
      phases.indexOf(ProducerIdentitiesPhase) + 1
    )
  })
})
