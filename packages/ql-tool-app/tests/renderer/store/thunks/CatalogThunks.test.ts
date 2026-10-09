import { CatalogSnapshot, QueryErrorCode, QueryFailureKind } from "@wireio/ql-shared"

import { QueryPortError } from "@wireio/ql-tool-app/renderer/query"
import {
  ConnectionTest,
  ConnectionsActions,
  describeTable,
  loadCatalogOwners,
  loadOwner,
  resetCatalog,
  testConnection
} from "@wireio/ql-tool-app/renderer/store"

import { ConnectionFixtures } from "../../../common/ConnectionFixtures.js"
import { FakeWorkbench } from "../../../common/FakeWorkbench.js"

/** A loaded snapshot of `sample` with one table. */
function loadedSnapshot(): CatalogSnapshot {
  return {
    endpoint: ConnectionFixtures.Endpoint,
    capturedAt: FakeWorkbench.Now.toISOString(),
    owners: [
      { account: "sample", loaded: true, tables: [{ name: "positions", rowType: "position", fields: [], described: false }] }
    ]
  }
}

/** A workbench with an active profile. */
function readyWorkbench(): FakeWorkbench {
  const workbench = FakeWorkbench.create()
  workbench.store.dispatch(ConnectionsActions.profilesLoaded(FakeWorkbench.profilesOf("local")))
  return workbench
}

describe("CatalogThunks", () => {
  it("resetCatalog seeds the active profile's unloaded owners (none without a profile)", async () => {
    const empty = FakeWorkbench.create()
    await empty.store.dispatch(resetCatalog())
    expect(empty.store.getState().catalog.snapshot).toBeNull()
    const workbench = readyWorkbench()
    await workbench.store.dispatch(resetCatalog())
    expect(workbench.store.getState().catalog.snapshot.owners).toEqual([
      expect.objectContaining({ account: "sample", loaded: false })
    ])
  })

  it("loadOwner stores the snapshot; a failure is recorded", async () => {
    const workbench = readyWorkbench()
    workbench.queryPort.loadOwner.mockResolvedValueOnce(loadedSnapshot())
    await workbench.store.dispatch(loadOwner("sample"))
    expect(workbench.store.getState().catalog).toMatchObject({ loadingOwners: [], error: null })
    workbench.queryPort.loadOwner.mockRejectedValueOnce(new Error("abi missing"))
    await expect(workbench.store.dispatch(loadOwner("other"))).resolves.toBeUndefined()
    expect(workbench.store.getState().catalog).toMatchObject({ error: "abi missing", loadingOwners: [] })
    expect(workbench.store.getState().ui.notice).toBeNull()
  })

  it("a catalog failure answered by the host shows the failure's own message (engine kind kept, no folded context)", async () => {
    const workbench = readyWorkbench(),
      failure = { kind: QueryFailureKind.engine, message: "unknown table nope", code: QueryErrorCode.QUERY_SEMANTICS, data: null }
    workbench.queryPort.describe.mockRejectedValueOnce(new QueryPortError(failure))
    await workbench.store.dispatch(describeTable("sample", "nope"))
    expect(workbench.store.getState().catalog.error).toBe("unknown table nope")
  })

  it("describeTable goes through the port; a failure is recorded", async () => {
    const workbench = readyWorkbench()
    workbench.queryPort.describe.mockRejectedValueOnce(new Error("no such table"))
    await workbench.store.dispatch(describeTable("sample", "nope"))
    expect(workbench.store.getState().catalog.error).toBe("no such table")
    expect(workbench.queryPort.describe).toHaveBeenCalledWith("req-1", expect.anything(), "sample", "nope")
  })

  it("loadCatalogOwners reloads only the loaded owners", async () => {
    const workbench = readyWorkbench()
    workbench.queryPort.loadOwner.mockResolvedValue(loadedSnapshot())
    await workbench.store.dispatch(loadOwner("sample"))
    workbench.queryPort.loadOwner.mockClear()
    await workbench.store.dispatch(loadCatalogOwners())
    expect(workbench.queryPort.loadOwner.mock.calls.map(([, , owner]) => owner)).toEqual(["sample"])
  })

  it("testConnection reports passed with the table count, or the failure", async () => {
    const workbench = readyWorkbench(),
      profile = FakeWorkbench.profilesOf("local").profiles[0]
    workbench.queryPort.loadOwner.mockResolvedValueOnce(loadedSnapshot())
    workbench.queryPort.describe.mockResolvedValueOnce(loadedSnapshot())
    await expect(workbench.store.dispatch(testConnection(profile))).resolves.toBe(
      `${ConnectionTest.Passed}: sample has 1 tables`
    )
    workbench.queryPort.loadOwner.mockRejectedValueOnce(new Error("ECONNREFUSED"))
    await expect(workbench.store.dispatch(testConnection(profile))).resolves.toBe(`${ConnectionTest.Failed}: ECONNREFUSED`)
  })
})
