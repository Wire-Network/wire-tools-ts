import Path from "node:path"
import { EthereumWallet } from "@wireio/cluster-tool/clients/ethereum"
import { ClusterBuildDefaults } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { EthereumFundingTool } from "@wireio/cluster-tool/tools/ethereum"
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

/** The local Ethereum outpost phase and its steps, in the order the deploy requires them. */
const EthereumOutpostPhase = "EthereumOutpost"
const OperatorKeysPhase = "OperatorKeys"
const StartAnvilStep = "start-anvil"
const CreateDeployerStep = "create-ethereum-deployer"
const FundDeployerStep = "fund-ethereum-deployer"
const CreatePanicStep = "create-ethereum-panic-account"
const FundPanicStep = "fund-ethereum-panic-account"
const DeployStep = "deploy-ethereum"
const VerifyPoolStep = "verify-syndication-pool"
const IntervalMiningStep = "enable-interval-mining"
/** The four wallet steps — every one absent in external-outpost mode. */
const WalletSteps = [
  CreateDeployerStep,
  FundDeployerStep,
  CreatePanicStep,
  FundPanicStep
] as const

describe("ClusterBuildDefaults — EthereumOutpost deployer + panic wallets", () => {
  let environment: ResolveEnvironment

  beforeEach(() => {
    environment = fixtureResolveEnvironment("ethereum-outpost-")
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

  it("creates and funds the deployer, then the panic account, between start-anvil and deploy-ethereum", async () => {
    // The deploy signs as the deployer and names the panic account, so both
    // random wallets must exist and hold ETH before `deployLocal.ts` runs —
    // and the anvil they are funded on must be up first.
    const cluster = await ClusterBuildDefaults.create(baseOptions()),
      phase = findPhase(cluster.children, EthereumOutpostPhase)
    expect(phase.steps.map(step => step.name)).toEqual([
      StartAnvilStep,
      CreateDeployerStep,
      FundDeployerStep,
      CreatePanicStep,
      FundPanicStep,
      DeployStep,
      VerifyPoolStep,
      IntervalMiningStep
    ])
  })

  it("names the persisted handles and the bootstrap balances on the wallet steps, as the Ethereum-outpost actor", async () => {
    const cluster = await ClusterBuildDefaults.create(baseOptions()),
      phase = findPhase(cluster.children, EthereumOutpostPhase),
      step = (name: string) => phase.steps.find(candidate => candidate.name === name)
    expect(step(CreateDeployerStep).input).toEqual({
      kind: "EthereumFundingTool.CreateWalletInput",
      walletName: EthereumWallet.DeployerWalletName,
      purpose: expect.any(String)
    })
    expect(step(FundDeployerStep).input).toEqual({
      kind: "EthereumFundingTool.SetBalanceInput",
      walletName: EthereumWallet.DeployerWalletName,
      balanceWei: EthereumFundingTool.DeployerBalanceWei
    })
    expect(step(CreatePanicStep).input).toEqual({
      kind: "EthereumFundingTool.CreateWalletInput",
      walletName: EthereumWallet.PanicWalletName,
      purpose: expect.any(String)
    })
    expect(step(FundPanicStep).input).toEqual({
      kind: "EthereumFundingTool.SetBalanceInput",
      walletName: EthereumWallet.PanicWalletName,
      balanceWei: EthereumFundingTool.PanicBalanceWei
    })
    expect(step(CreateDeployerStep).runner).toBe(
      EthereumFundingTool.runCreateWallet
    )
    expect(step(CreatePanicStep).runner).toBe(EthereumFundingTool.runCreateWallet)
    expect(step(FundDeployerStep).runner).toBe(EthereumFundingTool.runSetBalance)
    expect(step(FundPanicStep).runner).toBe(EthereumFundingTool.runSetBalance)
    WalletSteps.forEach(name =>
      expect(step(name).actor).toBe(Report.Actor.EthereumOutpost)
    )
  })

  it("materializes the batch operators (OperatorKeys) BEFORE the outpost phase — the provisional roster seats their random addresses", async () => {
    const cluster = await ClusterBuildDefaults.create(baseOptions()),
      phases = collectPhaseNames(cluster.children)
    expect(phases.indexOf(OperatorKeysPhase)).toBeGreaterThanOrEqual(0)
    expect(phases.indexOf(OperatorKeysPhase)).toBeLessThan(
      phases.indexOf(EthereumOutpostPhase)
    )
  })

  it("omits the phase — and with it every wallet step — in external-outpost mode", async () => {
    const cluster = await ClusterBuildDefaults.create({
        ...baseOptions(),
        externalOutpostConfig: fixtureExternalOutpostConfig(environment.rootPath)
      }),
      steps = collectStepNames(cluster.children)
    expect(collectPhaseNames(cluster.children)).not.toContain(
      EthereumOutpostPhase
    )
    WalletSteps.forEach(name => expect(steps).not.toContain(name))
  })
})
