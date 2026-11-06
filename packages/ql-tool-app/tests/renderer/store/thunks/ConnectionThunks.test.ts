import { ConnectionTest, testConnection } from "@wireio/ql-tool-app/renderer/store"

import { FakeWorkbench } from "../../../common/FakeWorkbench.js"

/** Fixture constants. */
namespace Fixture {
  export const Result = { chainId: "ab".repeat(32), headBlockNum: 1_234 }
}

describe("ConnectionThunks", () => {
  it("testConnection asks the query host once and reports the node it reached", async () => {
    const workbench = FakeWorkbench.create(),
      profile = FakeWorkbench.profilesOf("local").profiles[0]
    workbench.queryPort.testConnection.mockResolvedValueOnce(Fixture.Result)
    await expect(workbench.store.dispatch(testConnection(profile))).resolves.toBe(
      ConnectionTest.passedMessage(Fixture.Result)
    )
    expect(workbench.queryPort.testConnection).toHaveBeenCalledWith(expect.any(String), profile)
    expect(workbench.queryPort.loadOwner).not.toHaveBeenCalled()
    expect(workbench.queryPort.describe).not.toHaveBeenCalled()
  })

  it("testConnection reports the failure", async () => {
    const workbench = FakeWorkbench.create(),
      profile = FakeWorkbench.profilesOf("local").profiles[0]
    workbench.queryPort.testConnection.mockRejectedValueOnce(new Error("ECONNREFUSED"))
    await expect(workbench.store.dispatch(testConnection(profile))).resolves.toBe(`${ConnectionTest.Failed}: ECONNREFUSED`)
  })

  it("passedMessage names the chain-id prefix and the head block", () => {
    expect(ConnectionTest.passedMessage(Fixture.Result)).toBe(
      `${ConnectionTest.Passed}: chain ${"ab".repeat(6)}…, head block 1234; query engine answering`
    )
    expect(ConnectionTest.ChainIdPrefixLength).toBe(12)
  })
})
