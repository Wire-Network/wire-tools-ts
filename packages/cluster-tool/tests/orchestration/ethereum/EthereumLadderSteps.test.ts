import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { ClusterBuildContext } from "@wireio/cluster-tool/orchestration"
import {
  EthereumLadderSteps,
  EthereumOutpostBootstrapper
} from "@wireio/cluster-tool/orchestration/ethereum"
import { ClusterConfigProvider } from "@wireio/cluster-tool/config"
import { getLogger } from "@wireio/cluster-tool/logging"
import { Report } from "@wireio/cluster-tool/report"
import { fixtureConfig } from "../../config/clusterConfigFixture.js"

describe("EthereumLadderSteps", () => {
  let context: ClusterBuildContext
  let dataPath: string
  beforeEach(() => {
    dataPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), "ethereum-ladder-steps-"))
    context = new ClusterBuildContext({ ...fixtureConfig(), dataPath }, getLogger("ladder-steps-test"))
    Fs.mkdirSync(ClusterConfigProvider.ethereumDeploymentsPath(context.config), { recursive: true })
  })
  afterEach(() => {
    Fs.rmSync(dataPath, { recursive: true, force: true })
  })

  it("plans the three scripts as input-less Steps with their own runners", () => {
    const ladder = EthereumLadderSteps.planLadder(Report.Actor.EthereumOutpost, "ladder", "ladder", {}),
      freeze = EthereumLadderSteps.planDeepFreeze(Report.Actor.EthereumOutpost, "freeze", "freeze", {}),
      goLive = EthereumLadderSteps.planGoLive(Report.Actor.EthereumOutpost, "go-live", "go-live", {})
    expect([ladder, freeze, goLive].map(step => step.runner)).toEqual([
      EthereumLadderSteps.runLadder,
      EthereumLadderSteps.runDeepFreeze,
      EthereumLadderSteps.runGoLive
    ])
    ;[ladder, freeze, goLive].forEach(step => expect(step.input).toBeNull())
  })

  it("reads the ladder summary the script wrote, through its codec", () => {
    const summary = {
      owner: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      liqEthAddressFile: "/x/liqeth-addrs.json",
      outpostAddressFile: "/x/outpost-addrs.json",
      outpostReleaseStateFile: "/x/outpost-release-state.json",
      wireNodes: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
      saltVersion: "2",
      stoppedBefore: "outpost_20269999.01_deep_freeze",
      completed: ["deployLiqEth", "deployOutpost"],
      liqEth: { LiqEthToken: "0x1" },
      outpost: { OPP: "0x2", MockWireNodes: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0" }
    }
    Fs.writeFileSync(
      Path.join(
        ClusterConfigProvider.ethereumDeploymentsPath(context.config),
        EthereumOutpostBootstrapper.LadderSummaryFile
      ),
      JSON.stringify(summary)
    )
    expect(EthereumLadderSteps.readLadderSummary(context)).toEqual(summary)
  })

  it("refuses a summary missing what the orchestrator reads", () => {
    Fs.writeFileSync(
      Path.join(
        ClusterConfigProvider.ethereumDeploymentsPath(context.config),
        EthereumOutpostBootstrapper.LadderSummaryFile
      ),
      JSON.stringify({ owner: "0x1" })
    )
    expect(() => EthereumLadderSteps.readLadderSummary(context)).toThrow()
  })

  it("reads the freeze's release state, keeping keys later steps add", () => {
    Fs.writeFileSync(
      Path.join(
        ClusterConfigProvider.ethereumDeploymentsPath(context.config),
        EthereumOutpostBootstrapper.OutpostReleaseStateFile
      ),
      JSON.stringify({
        depositorLastPoolLiqBalance: "83240000000000000000",
        depositorTotalShares: "79160000000000000000",
        depositorIndex: "1050300000000000000000000000",
        depositorDDay: false,
        legacyOpp: "0x3"
      })
    )
    const state = EthereumLadderSteps.readFreezeReleaseState(context)
    expect(BigInt(state.depositorLastPoolLiqBalance)).toBe(83_240_000_000_000_000_000n)
    expect(state.depositorDDay).toBe(false)
    expect((state as Record<string, unknown>).legacyOpp).toBe("0x3")
  })
})
