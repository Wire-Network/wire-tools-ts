import Path from "node:path"
import { Name } from "@wireio/sdk-core"
import { Constants } from "@wireio/cluster-tool/Constants"
import {
  ClusterBuildDefaults,
  ClusterBuildPhase,
  ClusterBuildPhaseGroup
} from "@wireio/cluster-tool/orchestration"
import {
  fixtureResolveEnvironment,
  type ResolveEnvironment
} from "../config/resolveEnvironmentFixture.js"

import { collectPhaseNames, collectStepNames } from "./clusterBuildFixture.js"

describe("ClusterBuildDefaults — underwriting, syndication and the emergency stop", () => {
  let environment: ResolveEnvironment

  beforeEach(() => {
    environment = fixtureResolveEnvironment("syndication-")
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

  /** Assert `names` holds every entry of `ordered`, each after the one before it. */
  function expectInOrder(names: string[], ordered: string[]): void {
    const positions = ordered.map(name => names.indexOf(name))
    positions.forEach((position, index) =>
      expect({ name: ordered[index], present: position >= 0 }).toEqual({
        name: ordered[index],
        present: true
      })
    )
    expect(positions).toEqual(
      [...positions].sort((left, right) => left - right)
    )
  }

  it("composes the phases in contract-upgrade order: deploy, grant, arm the cord, register, configure", async () => {
    const cluster = await ClusterBuildDefaults.create(baseOptions()),
      names = collectPhaseNames(cluster.children)
    expectInOrder(names, [
      "OPPContracts",
      "OPPCodeGrants",
      "PanicAccount",
      "EmergencyStop",
      "Registry",
      "ShadowLiqTokens",
      "SyndicationConfig",
      "EpochBootstrap"
    ])
    expect(names.indexOf("EmergencyStop")).toBe(
      names.indexOf("PanicAccount") + 1
    )
    expect(names.indexOf("SyndicationConfig")).toBe(
      names.indexOf("ShadowLiqTokens") + 1
    )
  })

  it("deploys sysio.andon before every cord reader, and sysio.bond before sysio.synd", async () => {
    const cluster = await ClusterBuildDefaults.create(baseOptions()),
      steps = collectStepNames(cluster.children)
    expectInOrder(steps, [
      "deploy-andon",
      "deploy-swap",
      "deploy-liq",
      "deploy-bond",
      "deploy-synd"
    ])
  })

  it("grants @sysio.code to sysio.bond and sysio.synd, and never to sysio.andon", async () => {
    const cluster = await ClusterBuildDefaults.create(baseOptions()),
      steps = collectStepNames(cluster.children)
    expect(steps).toContain("grant-sysio.bond")
    expect(steps).toContain("grant-sysio.synd")
    expect(steps).not.toContain("grant-sysio.andon")
  })

  it("creates the panic account, funds native permissions, then delegates and links both actions", async () => {
    const cluster = await ClusterBuildDefaults.create(baseOptions()),
      steps = collectStepNames(cluster.children)
    expect(Constants.PANIC_ACCOUNT).toBe("andon.panic")
    expectInOrder(steps, [
      "create-panic-account",
      "fund-andon-permission-ram",
      "delegate-andon-pull",
      "link-andon-pull",
      "delegate-andon-clear",
      "link-andon-clear"
    ])
    expect(steps).not.toContain("set-panic-account")
    expect(steps).not.toContain("add-synd-puller")
    expect(steps.indexOf("link-andon-clear")).toBeLessThan(
      steps.indexOf("seed-registry")
    )
  })

  it("delegates only pull/clear and preserves owner/active authority", async () => {
    const cluster = await ClusterBuildDefaults.create(baseOptions())
    const prerequisites = cluster.children.find(
      child =>
        child instanceof ClusterBuildPhaseGroup &&
        child.children.some(phase => phase.name === "EmergencyStop")
    )
    expect(prerequisites).toBeInstanceOf(ClusterBuildPhaseGroup)
    if (!(prerequisites instanceof ClusterBuildPhaseGroup))
      throw new Error("missing prerequisites")
    const phase = prerequisites.children.find(
      child => child.name === "EmergencyStop"
    )
    if (!(phase instanceof ClusterBuildPhase))
      throw new Error("missing emergency stop phase")
    expect(phase.steps).toHaveLength(5)
    expect(phase.steps[0].input).toEqual({
      kind: "AccountSteps.RamGrantInput",
      account: "sysio.andon",
      ramBytes: 10_400
    })
    expect(
      BigInt(Name.from(Constants.PANIC_ACCOUNT).value.toString())
    ).toBeLessThan(BigInt(Name.from("sysio").value.toString()))
    for (const [index, permission] of ["pull", "clear"].entries()) {
      const authorization = [{ actor: "sysio.andon", permission: "active" }]
      expect(phase.steps[1 + index * 2].input).toEqual({
        kind: "SystemContractSteps.UpdateauthInput",
        authorization,
        data: {
          account: "sysio.andon",
          permission,
          parent: "active",
          auth: {
            threshold: 1,
            keys: [],
            accounts: [
              {
                permission: { actor: "andon.panic", permission: "active" },
                weight: 1
              },
              {
                permission: { actor: "sysio", permission: "active" },
                weight: 1
              }
            ]
          }
        }
      })
      expect(phase.steps[2 + index * 2].input).toEqual({
        kind: "SystemContractSteps.LinkauthInput",
        authorization,
        data: {
          account: "sysio.andon",
          code: "sysio.andon",
          type: permission,
          requirement: permission
        }
      })
    }
  })

  /** The phase named `name`, wherever the bootstrap registers it. */
  function findPhase(
    cluster: Awaited<ReturnType<typeof ClusterBuildDefaults.create>>,
    name: string
  ): ClusterBuildPhase {
    const phase = cluster.children
      .flatMap(child => (child instanceof ClusterBuildPhaseGroup ? child.children : [child]))
      .find(child => child.name === name)
    if (!(phase instanceof ClusterBuildPhase)) throw new Error(`missing phase ${name}`)
    return phase
  }

  it("reserves the delegate name prefixes before either delegate account exists", async () => {
    const cluster = await ClusterBuildDefaults.create(baseOptions()),
      names = collectPhaseNames(cluster.children),
      phase = findPhase(cluster, "DelegateNamePrefixes")
    expect([...Constants.DELEGATE_NAME_PREFIXES]).toEqual(["andon", "bond"])
    expectInOrder(names, ["DelegateNamePrefixes", "PanicAccount", "JudgeAccount"])
    expect(phase.steps.map(step => step.name)).toEqual(["reserve-andon", "reserve-bond"])
    // Owned by sysio, with an active nothing satisfies: a node-owner claim of the name cannot match a key.
    phase.steps.forEach((step, index) =>
      expect(step.input).toEqual({
        kind: "AccountSteps.CreateSystemInput",
        account: Constants.DELEGATE_NAME_PREFIXES[index],
        active: {
          threshold: 1,
          keys: [],
          accounts: [{ permission: { actor: "sysio.null", permission: "active" }, weight: 1 }]
        }
      })
    )
  })

  it("creates the judge account, funds native permissions, then delegates and links both rulings", async () => {
    const cluster = await ClusterBuildDefaults.create(baseOptions()),
      names = collectPhaseNames(cluster.children),
      steps = collectStepNames(cluster.children)
    expect(Constants.JUDGE_ACCOUNT).toBe("bond.judge")
    expect(names.indexOf("JudgeAccount")).toBe(names.indexOf("EmergencyStop") + 1)
    expect(names.indexOf("BondRulings")).toBe(names.indexOf("JudgeAccount") + 1)
    expectInOrder(steps, [
      "create-judge-account",
      "fund-bond-permission-ram",
      "delegate-bond-rslvvalid",
      "link-bond-rslvvalid",
      "delegate-bond-rslvinvalid",
      "link-bond-rslvinvalid"
    ])
    expect(findPhase(cluster, "JudgeAccount").steps[0].input).toEqual({
      kind: "UserSteps.ProvisionWireInput",
      account: "bond.judge",
      fundWireAmount: 0n
    })
  })

  it("funds sysio.bond, then delegates and links exactly rslvvalid and rslvinvalid", async () => {
    const cluster = await ClusterBuildDefaults.create(baseOptions()),
      phase = findPhase(cluster, "BondRulings")
    expect(phase.steps).toHaveLength(5)
    expect(phase.steps[0].input).toEqual({
      kind: "AccountSteps.RamGrantInput",
      account: "sysio.bond",
      ramBytes: 10_400
    })
    expect(
      BigInt(Name.from(Constants.JUDGE_ACCOUNT).value.toString())
    ).toBeLessThan(BigInt(Name.from("sysio").value.toString()))
    for (const [index, permission] of ["rslvvalid", "rslvinvalid"].entries()) {
      const authorization = [{ actor: "sysio.bond", permission: "active" }]
      expect(phase.steps[1 + index * 2].input).toEqual({
        kind: "SystemContractSteps.UpdateauthInput",
        authorization,
        data: {
          account: "sysio.bond",
          permission,
          parent: "active",
          auth: {
            threshold: 1,
            keys: [],
            accounts: [
              { permission: { actor: "bond.judge", permission: "active" }, weight: 1 },
              { permission: { actor: "sysio", permission: "active" }, weight: 1 }
            ]
          }
        }
      })
      expect(phase.steps[2 + index * 2].input).toEqual({
        kind: "SystemContractSteps.LinkauthInput",
        authorization,
        data: {
          account: "sysio.bond",
          code: "sysio.bond",
          type: permission,
          requirement: permission
        }
      })
    }
  })

  it("configures sysio.synd for every pair unconditionally — no opt-in flag gates it", async () => {
    const cluster = await ClusterBuildDefaults.create(baseOptions()),
      steps = collectStepNames(cluster.children)
    expectInOrder(steps, [
      "configure-bond",
      "configure-syndication-ethereum-liqeth",
      "configure-syndication-solana-liqsol",
      "verify-shadow-precision",
      "verify-liq-token-ethereum-liqeth",
      "verify-liq-token-solana-liqsol"
    ])
  })

  it("seeds the opt-in mock liq pools right after the syndication config", async () => {
    const cluster = await ClusterBuildDefaults.create({
        ...baseOptions(),
        enableMockLiqPools: true
      }),
      names = collectPhaseNames(cluster.children)
    expect(names.indexOf("MockLiqPools")).toBe(
      names.indexOf("SyndicationConfig") + 1
    )
  })
})
