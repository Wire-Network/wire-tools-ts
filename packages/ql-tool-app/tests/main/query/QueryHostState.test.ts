import { QueryHostEvent, QueryHostState } from "@wireio/ql-tool-app/main/query"

describe("QueryHostState / QueryHostEvent", () => {
  it.each([
    ["QueryHostState", QueryHostState],
    ["QueryHostEvent", QueryHostEvent]
  ])("%s is an identity enum", (_name, members: Record<string, string>) => {
    Object.entries(members).forEach(([key, value]) => expect(value).toBe(key))
  })

  it("names the six launcher states and eight inputs", () => {
    expect(Object.keys(QueryHostState).sort()).toEqual(["backoff", "disposed", "failed", "idle", "ready", "spawning"])
    expect(Object.keys(QueryHostEvent)).toHaveLength(8)
  })
})
