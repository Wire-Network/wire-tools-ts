import { ConnectionActions, ConnectionSlice, initialConnectionState } from "@wireio/ql-tool-cli/tui/index.js"

const profile = { name: "p", endpoint: "http://e.example", transportTimeoutMs: 1, retries: 0 }

describe("ConnectionSlice", () => {
  it("selects a profile and loads the profiles document", () => {
    const selected = ConnectionSlice.reducer(initialConnectionState, ConnectionActions.profileSelected(profile)),
      loaded = ConnectionSlice.reducer(selected, ConnectionActions.profilesLoaded({ defaultProfile: "p", profiles: [profile, { ...profile, name: "q" }] }))
    expect(selected.profile).toEqual(profile)
    expect(loaded).toMatchObject({ defaultProfile: "p", cursor: 0 })
    expect(ConnectionSlice.reducer(loaded, ConnectionActions.cursorMoved(5)).cursor).toBe(1)
  })

  it("clamps the cursor on an empty or shrinking list", () => {
    const moved = { ...initialConnectionState, profiles: [profile, profile], cursor: 1 }
    expect(ConnectionSlice.reducer(moved, ConnectionActions.profilesLoaded({ defaultProfile: null, profiles: [] })).cursor).toBe(0)
    expect(ConnectionSlice.reducer(initialConnectionState, ConnectionActions.cursorMoved(-3)).cursor).toBe(0)
  })
})
