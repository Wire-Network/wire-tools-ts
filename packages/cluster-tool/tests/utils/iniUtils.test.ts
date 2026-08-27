import { toIniLine } from "@wireio/cluster-tool/utils"

describe("toIniLine", () => {
  it("renders `<key> = <value>` with the spacing every emitted ini uses", () => {
    expect(toIniLine("http-threads", 4)).toBe("http-threads = 4")
  })

  it("stringifies booleans as nodeop's own true/false spellings", () => {
    expect(toIniLine("enable-account-queries", true)).toBe(
      "enable-account-queries = true"
    )
    expect(toIniLine("enable-account-queries", false)).toBe(
      "enable-account-queries = false"
    )
  })

  it("passes a string value through verbatim (endpoints keep their colon)", () => {
    expect(toIniLine("http-server-address", "0.0.0.0:8888")).toBe(
      "http-server-address = 0.0.0.0:8888"
    )
  })

  it("emits NO trailing newline — the renderers join lines themselves", () => {
    expect(toIniLine("agent-name", "wire-api-node").endsWith("\n")).toBe(false)
  })

  it("renders an empty string value as a bare `<key> = `", () => {
    // The edge case a renderer hits when an optional value resolves empty: the
    // key still appears, which is what nodeop's parser expects.
    expect(toIniLine("agent-name", "")).toBe("agent-name = ")
  })
})
