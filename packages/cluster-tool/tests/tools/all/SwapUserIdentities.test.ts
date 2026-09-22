import {
  ClusterBuildContext,
  swapUserOutputKey
} from "@wireio/cluster-tool/orchestration"
import { getLogger } from "@wireio/cluster-tool/logging"
import { Report, StepExtraRecorder } from "@wireio/cluster-tool/report"
import { SwapUserIdentities } from "@wireio/cluster-tool/tools/all"
import { fixtureConfig } from "../../config/clusterConfigFixture.js"

function newContext(): ClusterBuildContext {
  return new ClusterBuildContext(
    fixtureConfig(),
    getLogger("swap-user-identities-test")
  )
}

describe("SwapUserIdentities", () => {
  it("builds identity and airdrop Steps with the selected actor index", () => {
    const identity = SwapUserIdentities.planIdentityCreation(
        Report.Actor.User,
        "identity-3",
        "create actor 3",
        {},
        SwapUserIdentities.DefaultEthereumHdIndex + 3,
        3
      ),
      airdrop = SwapUserIdentities.planAirdrop(
        Report.Actor.User,
        "airdrop-3",
        "fund actor 3",
        {},
        7,
        3
      )

    expect(identity.input.actorIndex).toBe(3)
    expect(identity.input.ethereumHdIndex).toBe(
      SwapUserIdentities.DefaultEthereumHdIndex + 3
    )
    expect(airdrop.input.actorIndex).toBe(3)
    expect(airdrop.input.floorLamports).toBe(7)
  })

  it("stores each generated identity under its indexed output key", async () => {
    const ctx = newContext(),
      recorder = new StepExtraRecorder()

    await StepExtraRecorder.runWith(recorder, () =>
      SwapUserIdentities.runIdentityCreation(
        ctx,
        {
          kind: "SwapUserIdentities.ProvisionIdentityInput",
          ethereumHdIndex: SwapUserIdentities.DefaultEthereumHdIndex + 2,
          actorIndex: 2
        },
        new AbortController().signal
      )
    )

    const identity = ctx.outputs.assert(swapUserOutputKey(2))
    expect(identity.ethereumWallet.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(identity.solanaKeypair.publicKey.toBase58().length).toBeGreaterThan(
      0
    )
    expect(ctx.outputs.get(swapUserOutputKey(1))).toBeNull()
    expect(recorder.calls.filter(call => call.kind === "keygen")).toHaveLength(
      2
    )
  })

  it("keeps single-user calls on index zero and rejects invalid indexes", () => {
    expect(swapUserOutputKey().name).toBe(swapUserOutputKey(0).name)
    expect(swapUserOutputKey(1).name).not.toBe(swapUserOutputKey(0).name)
    expect(() => swapUserOutputKey(-1)).toThrow(/non-negative safe integer/)
  })
})
