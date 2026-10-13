import { PidSourceKind } from "@wireio/debugging-shared"

describe("PidSourceKind", () => {
  it("is identity-mapped — every value equals its key", () => {
    Object.entries(PidSourceKind).forEach(([key, value]) =>
      expect(value).toBe(key)
    )
  })

  it("classifies every monitored process kind, the api node included", () => {
    // Literal spellings: the independent oracle for the `[kind]` text the TUI
    // renders and the `kind` values the debugging RPC payload carries.
    expect(Object.values(PidSourceKind)).toEqual([
      "bios",
      "producer",
      "batch_operator",
      "underwriter",
      "api",
      "anvil",
      "solana_validator"
    ])
  })
})
