import { findKeyMaterial } from "@wireio/cluster-tool-shared"

import type { ClusterBuildContext } from "@wireio/cluster-tool/orchestration/ClusterBuildContext"
import { OutputStore } from "@wireio/cluster-tool/orchestration/OutputStore"
import { swapUserOutputKey } from "@wireio/cluster-tool/orchestration/outputs/SwapUserOutput"
import { StepExtraRecorder } from "@wireio/cluster-tool/report/tools/StepExtraRecorder"
import { SwapUserIdentities } from "@wireio/cluster-tool/tools/all/SwapUserIdentities"

describe("SwapUserIdentities", () => {
  it("stores the ephemeral user for later Steps but records public identity only", async () => {
    const outputs = new OutputStore(),
      context = {
        ethereum: { provider: null },
        outputs
      } as unknown as ClusterBuildContext,
      recorder = new StepExtraRecorder()

    await StepExtraRecorder.runWith(recorder, () =>
      SwapUserIdentities.runIdentityCreation(
        context,
        {
          kind: "SwapUserIdentities.ProvisionIdentityInput",
          ethereumHdIndex: SwapUserIdentities.DefaultEthereumHdIndex
        },
        new AbortController().signal
      )
    )

    const user = outputs.assert(swapUserOutputKey()),
      serialized = JSON.stringify(recorder.calls)
    expect(serialized).toContain(user.ethereumWallet.address)
    expect(serialized).toContain(user.solanaKeypair.publicKey.toBase58())
    expect(serialized).not.toContain(user.ethereumWallet.privateKey)
    expect(serialized).not.toContain(
      Buffer.from(user.solanaKeypair.secretKey).toString("base64")
    )
    expect(findKeyMaterial(serialized)).toEqual([])
  })
})
