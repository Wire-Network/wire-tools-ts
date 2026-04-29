/**
 * RootState is a type-only re-export from Store.ts. Its purpose is to let
 * selector files depend on the RootState type without pulling in the whole
 * Store module (and thereby breaking the slice→Store→slice cycle). The
 * presence of the file is the invariant; verify the alias resolves.
 */
import type { RootState } from "@wireio/debugging-client-tool-tui/store/RootState.js"
import { store } from "@wireio/debugging-client-tool-tui/store/Store.js"

describe("RootState type re-export", () => {
  it("matches the runtime state shape produced by store.getState()", () => {
    const snapshot = store.getState()
    const typed: RootState = snapshot
    expect(typed).toBe(snapshot)
  })
})
