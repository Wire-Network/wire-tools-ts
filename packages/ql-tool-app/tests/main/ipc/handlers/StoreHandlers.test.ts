import Path from "node:path"

import { ConnectionProfile } from "@wireio/ql-shared"
import { ConnectionProfileStore, QueryHistoryStore, SavedQueryStore } from "@wireio/ql-shared/node"

import { createStoreHandlers } from "@wireio/ql-tool-app/main/ipc"
import { StoreService } from "@wireio/ql-tool-app/main/services"

import { FakeWebContents } from "../../../__mocks__/electron.js"
import { ConnectionFixtures } from "../../../common/ConnectionFixtures.js"
import { HistoryFixtures } from "../../../common/HistoryFixtures.js"
import { TempDirectory } from "../../../common/TempDirectory.js"

/** Fixture constants. */
namespace Fixture {
  export const Query = "SELECT * FROM sysio.accounts"
}

const sender = new FakeWebContents() as unknown as Electron.WebContents

/** Handlers over stores in a new temp directory. */
function newHandlers(): ReturnType<typeof createStoreHandlers> {
  const directory = TempDirectory.create()
  return createStoreHandlers(
    new StoreService({
      profiles: new ConnectionProfileStore(Path.join(directory, "profiles.json")),
      saved: new SavedQueryStore(Path.join(directory, "saved-queries.json")),
      history: new QueryHistoryStore({ file: Path.join(directory, "history.jsonl") })
    })
  )
}

describe("createStoreHandlers", () => {
  it("profile CRUD round-trips through the store", async () => {
    const handlers = newHandlers()
    expect((await handlers.profilesList(undefined, sender)).profiles).toEqual([])
    const upserted = await handlers.profilesUpsert(
      ConnectionProfile.create({ name: HistoryFixtures.ProfileName, endpoint: ConnectionFixtures.Endpoint, retries: 0 }),
      sender
    )
    expect(upserted.profiles.map(profile => profile.name)).toEqual([HistoryFixtures.ProfileName])
    expect((await handlers.profilesSetDefault({ name: HistoryFixtures.ProfileName }, sender)).defaultProfile).toBe(
      HistoryFixtures.ProfileName
    )
    expect((await handlers.profilesRemove({ name: HistoryFixtures.ProfileName }, sender)).profiles).toEqual([])
  })

  it("an unknown profile name is an error", async () => {
    await expect(newHandlers().profilesSetDefault({ name: "missing" }, sender)).rejects.toThrow(/missing/)
  })

  it("history append / search / clear", async () => {
    const handlers = newHandlers()
    await handlers.historyAppend(HistoryFixtures.entry("a", Fixture.Query), sender)
    await handlers.historyAppend(HistoryFixtures.entry("b", "SELECT 1"), sender)
    expect((await handlers.historyList({ limit: 10, search: "accounts" }, sender)).map(entry => entry.id)).toEqual([
      "a"
    ])
    await handlers.historyClear(undefined, sender)
    expect(await handlers.historyList({ limit: 10, search: "" }, sender)).toEqual([])
  })

  it("saved upsert by name, then remove", async () => {
    const handlers = newHandlers()
    await handlers.savedUpsert({ name: "q", query: "SELECT 1" }, sender)
    const saved = await handlers.savedUpsert({ name: "q", query: Fixture.Query }, sender)
    expect(saved.map(({ name, query }) => ({ name, query }))).toEqual([{ name: "q", query: Fixture.Query }])
    expect(await handlers.savedRemove({ name: "q" }, sender)).toEqual([])
  })
})
