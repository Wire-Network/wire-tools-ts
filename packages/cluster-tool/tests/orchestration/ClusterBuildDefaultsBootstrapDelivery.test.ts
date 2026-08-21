import Fs from "node:fs"
import Path from "node:path"
import { ClusterBuildDefaults } from "@wireio/cluster-tool/orchestration"
import {
  fixtureResolveEnvironment,
  type ResolveEnvironment
} from "../config/resolveEnvironmentFixture.js"

import { collectPhaseNames, collectStepNames } from "./clusterBuildFixture.js"

/**
 * WNE-41 — the genesis-delivery grant phase.
 *
 * `OPPInbound.epochIn` authorizes on the outpost's AccessManager until the
 * first batch-operator roster installs, and the address that actually sends it
 * is each batch operator's own EOA. These assertions pin the three properties
 * that make the phase work: it exists in local mode, it carries ONE step per
 * batch operator, and it is registered AFTER the operators are provisioned but
 * BEFORE the daemons that deliver start.
 */
describe("ClusterBuildDefaults — bootstrap-delivery grants", () => {
  let environment: ResolveEnvironment, externalConfigFile: string

  beforeEach(() => {
    environment = fixtureResolveEnvironment("bootstrap-delivery-")
    externalConfigFile = Path.join(environment.rootPath, "external-outpost.json")
    Fs.writeFileSync(
      externalConfigFile,
      JSON.stringify({
        ethereum: {
          addressFile: "outpost-addrs.json",
          abiFiles: ["eth-abis/OPP.json"],
          chainId: 11_155_111
        },
        solana: { idlFile: "solana-idls/liqsol_core.json" }
      })
    )
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

  it("composes one grant step per batch operator in local mode", async () => {
    const batchOperatorCount = 3
    const cluster = await ClusterBuildDefaults.create({
      ...baseOptions(),
      batchOperatorCount
    })

    expect(collectPhaseNames(cluster.children)).toContain(
      "GrantBootstrapDelivery"
    )
    const grantSteps = collectStepNames(cluster.children).filter(name =>
      name.startsWith("grant-bootstrap-delivery-")
    )
    expect(grantSteps).toHaveLength(batchOperatorCount)
    // One step per operator — never one step looping over N.
    expect(new Set(grantSteps).size).toBe(batchOperatorCount)
  })

  it("grants AFTER operator provisioning and BEFORE the operator nodes start", async () => {
    const cluster = await ClusterBuildDefaults.create(baseOptions())
    const names = collectPhaseNames(cluster.children)

    // The operators must exist to be granted, and must hold the role before
    // their daemons deliver epoch 1.
    expect(names.indexOf("GrantBootstrapDelivery")).toBeGreaterThan(
      names.indexOf("Create batchops & uws")
    )
    expect(names.indexOf("GrantBootstrapDelivery")).toBeLessThan(
      names.indexOf("OperatorNodes")
    )
    expect(names.indexOf("GrantBootstrapDelivery")).toBeLessThan(
      names.indexOf("EpochBootstrap")
    )
  })

  it("omits the phase in external-outpost mode", async () => {
    const cluster = await ClusterBuildDefaults.create({
      ...baseOptions(),
      externalOutpostConfig: externalConfigFile,
      // External mode has no local outpost to bond underwriter collateral on,
      // so `ClusterConfigProvider.resolve` demands an EXPLICIT zero.
      underwriterCount: 0
    })
    const names = collectPhaseNames(cluster.children)

    expect(names).toContain("MaterializeExternalOutposts")
    // This run deployed no outpost and holds no admin authority over the
    // external ones; their deliverers are authorized out of band.
    expect(names).not.toContain("GrantBootstrapDelivery")
  })
})
