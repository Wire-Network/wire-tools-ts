import { OppProtocolCapabilities } from "@wireio/cluster-tool-shared"
import { WireClient } from "@wireio/cluster-tool/clients/wire"
import { Steps } from "@wireio/cluster-tool/orchestration"
import { OperatorDaemonArtifactsKey } from "@wireio/cluster-tool/orchestration/outputs/OperatorDaemonArtifacts"

import { fixtureContext } from "../../config/clusterBuildContextFixture.js"
import { fixtureExternalOutposts } from "../../config/resolveEnvironmentFixture.js"

describe("outpost activation protocol compatibility", () => {
  let invoke: jest.SpyInstance

  beforeEach(() => {
    invoke = jest.spyOn(WireClient.prototype, "invoke").mockResolvedValue(null)
  })
  afterEach(() => invoke.mockRestore())

  /** Drive the actual activation runner with operator-declared capabilities and no RPC writes. */
  async function activate(solana: OppProtocolCapabilities): Promise<void> {
    const externalOutposts = fixtureExternalOutposts(),
      ctx = fixtureContext({ externalOutposts })
    // Exercise the activation boundary even if a previously resolved config was altered.
    ctx.config.externalOutposts.solana.oppProtocol = solana
    ctx.outputs.set(OperatorDaemonArtifactsKey, {
      ethereumAbiFiles: [], ethereumAddresses: { OPP: "outbound", OPPInbound: "inbound" },
      solanaProgramId: "solana-program", solanaIdlFile: "/external/idl.json"
    })
    await Steps.registry.runSeedOutpostAddresses(ctx, null, new AbortController().signal)
  }

  it("activates both compatible outposts", async () => {
    await activate({ emit: [1], receive: [1, 2] })
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it.each([
    { emit: [1, 2], receive: [1] },
    { emit: [1], receive: [2] }
  ])("refuses either incompatible direction before activating Ethereum", async capabilities => {
    await expect(activate(capabilities)).rejects.toThrow("Incompatible OPP payload versions")
    expect(invoke).not.toHaveBeenCalled()
  })

  it("refuses missing metadata even on an already-resolved config", async () => {
    await expect(activate(null)).rejects.toThrow("missing or malformed")
    expect(invoke).not.toHaveBeenCalled()
  })
})
