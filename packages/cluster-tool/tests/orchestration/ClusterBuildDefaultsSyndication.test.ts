import Path from "node:path"
import { Constants } from "@wireio/cluster-tool/Constants"
import { ClusterBuildDefaults } from "@wireio/cluster-tool/orchestration"
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
    expect(positions).toEqual([...positions].sort((left, right) => left - right))
  }

  it("composes the phases in contract-upgrade order: deploy, grant, arm the cord, register, configure", async () => {
    const cluster = await ClusterBuildDefaults.create(baseOptions()),
      names = collectPhaseNames(cluster.children)
    expectInOrder(names, [
      "OPPContracts",
      "OPPCodeGrants",
      "BootstrapNodeOwner",
      "PanicAccount",
      "EmergencyStop",
      "Registry",
      "ShadowLiqTokens",
      "LiqConfig",
      "SyndicationConfig",
      "EpochBootstrap"
    ])
    expect(names.indexOf("PanicAccount")).toBe(names.indexOf("BootstrapNodeOwner") + 1)
    expect(names.indexOf("EmergencyStop")).toBe(names.indexOf("PanicAccount") + 1)
    expect(names.indexOf("SyndicationConfig")).toBe(names.indexOf("LiqConfig") + 1)
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

  it("creates the panic account, then names it and registers sysio.synd as a puller", async () => {
    const cluster = await ClusterBuildDefaults.create(baseOptions()),
      steps = collectStepNames(cluster.children)
    expect(Constants.PANIC_ACCOUNT).toBe("andon.panic")
    expectInOrder(steps, ["create-panic-account", "set-panic-account", "add-synd-puller"])
    expect(steps.indexOf("add-synd-puller")).toBeLessThan(steps.indexOf("seed-registry"))
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
    expect(names.indexOf("MockLiqPools")).toBe(names.indexOf("SyndicationConfig") + 1)
  })
})
