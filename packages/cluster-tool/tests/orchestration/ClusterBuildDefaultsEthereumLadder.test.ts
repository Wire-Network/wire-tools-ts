import Path from "node:path"
import { EthereumDeploymentKind } from "@wireio/cluster-tool-shared"
import { ClusterBuildDefaults } from "@wireio/cluster-tool/orchestration"
import {
  fixtureResolveEnvironment,
  type ResolveEnvironment
} from "../config/resolveEnvironmentFixture.js"
import { collectPhaseNames, collectStepNames } from "./clusterBuildFixture.js"

/** The create options each case varies. */
interface LadderCaseOptions {
  ethereumDeployment?: EthereumDeploymentKind
  enableMockLiqPools?: boolean
  enableMockSyndicationImport?: boolean
}

/** The ladder-only phases, in the order the bootstrap must run them. */
const LadderPhases = [
  "EthereumOutpost",
  "EthereumPreLaunch",
  "EthereumDeepFreeze",
  "EthereumLadderImport",
  "EthereumGoLive"
] as const

describe("ClusterBuildDefaults — Ethereum ladder deployment", () => {
  let environment: ResolveEnvironment
  beforeEach(() => {
    environment = fixtureResolveEnvironment("ethereum-ladder-")
  })
  afterEach(() => {
    environment.cleanup()
  })

  function create(options: LadderCaseOptions) {
    return ClusterBuildDefaults.create({
      clusterPath: Path.join(environment.rootPath, "cluster"),
      buildPath: environment.buildPath,
      ethereumPath: "/fake/ethereum",
      solanaPath: "/fake/solana",
      ...options
    })
  }

  it("defaults to the current deploy with none of the ladder phases", async () => {
    const cluster = await create({}),
      names = collectPhaseNames(cluster.children)
    expect(cluster.config.ethereumDeployment).toBe(EthereumDeploymentKind.current)
    expect(names).toContain("EthereumOutpost")
    LadderPhases.filter(name => name !== "EthereumOutpost").forEach(name =>
      expect(names).not.toContain(name)
    )
    expect(collectStepNames(cluster.children)).toContain("deploy-ethereum")
  })

  it("orders the ladder: anvil + ladder, the pre-launch use, the freeze, the import in the epoch-0 window, the go-live before the daemons", async () => {
    const cluster = await create({
        ethereumDeployment: EthereumDeploymentKind.ladder
      }),
      names = collectPhaseNames(cluster.children),
      steps = collectStepNames(cluster.children),
      at = (name: string) => {
        expect(names).toContain(name)
        return names.indexOf(name)
      }
    expect(cluster.config.ethereumDeployment).toBe(EthereumDeploymentKind.ladder)
    LadderPhases.reduce((previous, name) => {
      expect(at(name)).toBeGreaterThan(previous)
      return at(name)
    }, -1)
    expect(at("EthereumLadderImport")).toBeGreaterThan(at("SyndicationConfig"))
    expect(at("EthereumLadderImport")).toBeLessThan(at("EpochBootstrap"))
    expect(at("EthereumGoLive")).toBeLessThan(at("OperatorDaemonPrerequisites"))
    expect(at("SolanaValidator")).toBeGreaterThan(at("EthereumDeepFreeze"))
    // the fresh deploy's step is gone; the ladder's scripts are each one Step
    expect(steps).not.toContain("deploy-ethereum")
    ;["climb-ethereum-ladder", "freeze-ethereum", "go-live-ethereum", "snapshot-capital-index",
      "seed-liq-pool-ethereum-liqeth", "seal-syndication-import", "verify-ladder-import",
      "import-pretoken-seed-0", "seal-pretoken-import", "verify-go-live-reconciliation",
      "verify-syndication-pool", "enable-interval-mining"].forEach(name =>
      expect(steps).toContain(name)
    )
    // interval mining only after the go-live
    expect(steps.indexOf("enable-interval-mining")).toBeGreaterThan(steps.indexOf("go-live-ethereum"))
    expect(steps.filter(name => name === "enable-interval-mining")).toHaveLength(1)
    // the roster seed and epoch bootstrap are untouched
    expect(steps).toContain("seed-ethereum-roster")
  })

  it("reduces the mock seeding to Solana on a ladder cluster: no mock Ethereum pool, import or backing", async () => {
    const cluster = await create({
        ethereumDeployment: EthereumDeploymentKind.ladder,
        enableMockLiqPools: true,
        enableMockSyndicationImport: true
      }),
      names = collectPhaseNames(cluster.children),
      steps = collectStepNames(cluster.children)
    expect(names).toContain("MockLiqPools")
    expect(steps).toContain("seed-liq-pool-solana-liqsol")
    expect(steps.filter(name => name === "seed-liq-pool-ethereum-liqeth")).toHaveLength(1)
    expect(names).not.toContain("MockSyndicationImport")
    expect(steps).toContain("import-syndication-liqsol")
    expect(steps).toContain("materialize-mock-syndication-bonder")
    expect(steps.filter(name => name === "seal-syndication-import")).toHaveLength(1)
    expect(names).toContain("MockShadowBackingSolana")
    expect(names).not.toContain("MockShadowBackingEthereum")
  })

  it("imports no mock Solana credit when the flag is off", async () => {
    const steps = collectStepNames(
      (await create({ ethereumDeployment: EthereumDeploymentKind.ladder })).children
    )
    expect(steps).not.toContain("import-syndication-liqsol")
    expect(steps).not.toContain("materialize-mock-syndication-bonder")
  })
})
