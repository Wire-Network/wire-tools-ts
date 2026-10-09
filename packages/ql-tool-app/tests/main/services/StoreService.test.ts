import Fs from "node:fs"
import Path from "node:path"

import { pollUntil, sleep } from "@wireio/cluster-tool"
import { ConnectionProfileStore, QueryHistoryStore, SavedQueryStore } from "@wireio/ql-shared/node"

import { StoreKind } from "@wireio/ql-tool-app/common"
import { StoreService } from "@wireio/ql-tool-app/main/services"

import { HistoryFixtures } from "../../common/HistoryFixtures.js"
import { TempDirectory } from "../../common/TempDirectory.js"

/** Ceiling for one watch notification (well above the debounce). */
const WatchWaitMs = 3_000
/** How often a watch wait re-checks the recorded changes. */
const WatchPollIntervalMs = 20
/** Debounce windows a quiet period spans: long enough that a second (duplicate) notification would have fired. */
const QuietDebounceWindows = 4
/** A quiet period after which no further notification is expected. */
const QuietWindowMs = StoreService.WatchDebounceMs * QuietDebounceWindows

/** A service over a new temp directory. */
function newService(): StoreService {
  const directory = TempDirectory.create()
  return new StoreService({
    profiles: new ConnectionProfileStore(Path.join(directory, "profiles.json")),
    saved: new SavedQueryStore(Path.join(directory, "saved-queries.json")),
    history: new QueryHistoryStore({ file: Path.join(directory, "history.jsonl") })
  })
}

/**
 * Wait until `kind` was reported.
 *
 * @param changes - The recorded notifications.
 * @param kind - The store expected among them.
 */
async function waitForChange(changes: StoreKind[], kind: StoreKind): Promise<void> {
  await pollUntil(`a ${kind} store notification`, async () => changes.includes(kind), WatchWaitMs, WatchPollIntervalMs)
}

describe("StoreService", () => {
  it("reports a history append once per burst as StoreKind.history", async () => {
    const service = newService(),
      changes: StoreKind[] = []
    service.watch(kind => changes.push(kind))
    service.appendHistory(HistoryFixtures.entry("a", "SELECT 1"))
    await waitForChange(changes, StoreKind.history)
    await sleep(QuietWindowMs)
    service.close()
    expect(changes.filter(kind => kind === StoreKind.history)).toEqual([StoreKind.history])
  })

  it("reports a saved-query write as StoreKind.saved", async () => {
    const service = newService(),
      changes: StoreKind[] = []
    service.watch(kind => changes.push(kind))
    service.saveQuery({ name: "q", query: "SELECT 1" })
    await waitForChange(changes, StoreKind.saved)
    service.close()
    expect(changes).toContain(StoreKind.saved)
  })

  it("watchFile ignores other files in the directory and stops after unwatch", async () => {
    const directory = TempDirectory.create(),
      listener = jest.fn(),
      unwatch = StoreService.watchFile(Path.join(directory, "watched.jsonl"), listener)
    Fs.writeFileSync(Path.join(directory, "other.txt"), "x")
    await sleep(QuietWindowMs)
    expect(listener).not.toHaveBeenCalled()
    unwatch()
    Fs.writeFileSync(Path.join(directory, "watched.jsonl"), "x")
    await sleep(QuietWindowMs)
    expect(listener).not.toHaveBeenCalled()
  })
})
