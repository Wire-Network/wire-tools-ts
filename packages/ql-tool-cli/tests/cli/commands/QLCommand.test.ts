import {
  HistorySubcommand,
  ProfilesSubcommand,
  QLCommand,
  SavedSubcommand,
  SchemaSubcommand
} from "@wireio/ql-tool-cli/cli/index.js"

describe("wql command enums", () => {
  it.each([QLCommand, SchemaSubcommand, ProfilesSubcommand, HistorySubcommand, SavedSubcommand])(
    "are identity enums (%#)",
    enumeration => Object.entries(enumeration).forEach(([key, value]) => expect(value).toBe(key))
  )

  it("lists every command", () => {
    expect(Object.values(QLCommand)).toEqual(["query", "tui", "schema", "profiles", "history", "saved"])
  })
})
