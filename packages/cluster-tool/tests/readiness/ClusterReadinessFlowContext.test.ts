import { getLogger } from "@wireio/cluster-tool/logging"
import { ClusterReadinessFlowContext } from "@wireio/cluster-tool/readiness"
import { fixtureConfig } from "../config/clusterConfigFixture.js"

describe("ClusterReadinessFlowContext", () => {
  it("derives explicit probe endpoints from the resolved BindConfig", () => {
    const config = fixtureConfig(),
      context = new ClusterReadinessFlowContext(
        config,
        getLogger("cluster-readiness-flow-context-test")
      )
    expect(context.readiness.config.endpoints).toEqual({
      wireRpc: expect.stringContaining(
        String(config.bind.nodeop.ports.producers[0].http)
      ),
      ethereumRpc: expect.stringContaining(String(config.bind.anvil.port)),
      solanaRpc: expect.stringContaining(String(config.bind.solana.ports.http))
    })
    expect(context.readiness.config.expectedEthereumChainId).toBe(31_337)
  })
})
