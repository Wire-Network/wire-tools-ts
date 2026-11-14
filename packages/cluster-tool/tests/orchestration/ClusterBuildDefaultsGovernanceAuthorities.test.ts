import Path from "node:path"
import { Constants } from "@wireio/cluster-tool/Constants"
import { ClusterBuildDefaults, Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { WireSysioContractTool } from "@wireio/cluster-tool/tools/wire"
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

describe("ClusterBuildDefaults — governance authorities", () => {
  let environment: ResolveEnvironment, externalConfigFile: string

  beforeEach(() => {
    environment = fixtureResolveEnvironment("governance-authorities-")
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
    "creates both authorities once, after the other system accounts and before the producer handoff (%s mode)",
    async mode => {
      const cluster = await ClusterBuildDefaults.create(options(mode)),
        names = collectPhaseNames(cluster.children),
        steps = collectStepNames(cluster.children)
      expect(names.filter(name => name === "GovernanceAuthorities")).toHaveLength(1)
      expect(names.indexOf("GovernanceAuthorities")).toBe(
        names.indexOf("RemainingSystemAccounts") + 1
      )
      expect(names.indexOf("GovernanceAuthorities")).toBeGreaterThan(
        names.indexOf("Roa")
      )
      expect(names.indexOf("GovernanceAuthorities")).toBeLessThan(
        names.indexOf("ProducerHandoff")
      )
      Constants.GOVERNANCE_AUTHORITY_ACCOUNTS.forEach(account =>
        expect(steps.filter(name => name === `create-${account}`)).toHaveLength(1)
      )
    }
  )

  it("leaves the governance authorities out of the sysio@active system accounts", async () => {
    const cluster = await ClusterBuildDefaults.create(options("local")),
      created = findPhase(cluster.children, "RemainingSystemAccounts").steps.map(
        step => step.name
      )
    Constants.GOVERNANCE_AUTHORITY_ACCOUNTS.forEach(account =>
      expect(created).not.toContain(`create-${account}`)
    )
    expect(created).toContain("create-sysio.councl")
  })

  it("creates each with an unsatisfiable active, then raises its RAM for 21 members", async () => {
    const cluster = await ClusterBuildDefaults.create(options("local")),
      phaseSteps = findPhase(cluster.children, "GovernanceAuthorities").steps
    expect(phaseSteps.map(step => step.name)).toEqual([
      "create-sysio.nodes",
      "fund-sysio.nodes-authority-ram",
      "create-sysio.cncl",
      "fund-sysio.cncl-authority-ram"
    ])
    phaseSteps.forEach(step => expect(step.actor).toBe(Report.Actor.Sysio))
    const [createNodes, fundNodes, createCouncil, fundCouncil] = phaseSteps
    expect(createNodes.runner).toBe(Steps.account.runCreateSystem)
    expect(createNodes.input).toEqual({
      kind: "AccountSteps.CreateSystemInput",
      account: Constants.NODE_OWNERS_AUTHORITY,
      active: WireSysioContractTool.sysioNullActiveAuthority()
    })
    expect(createCouncil.input).toEqual({
      kind: "AccountSteps.CreateSystemInput",
      account: Constants.COUNCIL_AUTHORITY,
      active: WireSysioContractTool.sysioNullActiveAuthority()
    })
    expect(fundNodes.runner).toBe(Steps.account.runRamGrant)
    expect(fundNodes.input).toEqual({
      kind: "AccountSteps.RamGrantInput",
      account: Constants.NODE_OWNERS_AUTHORITY,
      ramBytes: Constants.GOVERNANCE_AUTHORITY_RAM_BYTES
    })
    expect(fundCouncil.input).toEqual({
      kind: "AccountSteps.RamGrantInput",
      account: Constants.COUNCIL_AUTHORITY,
      ramBytes: 640
    })
  })
})
