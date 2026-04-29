import { DebuggingServerClient } from "@wireio/debugging-client-shared"

describe("DebuggingServerClient", () => {
  it("exposes DefaultHost and DefaultPort namespace constants", () => {
    expect(typeof DebuggingServerClient.DefaultHost).toBe("string")
    expect(typeof DebuggingServerClient.DefaultPort).toBe("number")
    expect(DebuggingServerClient.DefaultHost).toBe("127.0.0.1")
    expect(DebuggingServerClient.DefaultPort).toBe(9876)
  })

  it("rejects create() when server is not reachable", async () => {
    await expect(
      DebuggingServerClient.create({ baseUrl: "http://127.0.0.1:1" })
    ).rejects.toThrow()
  })
})
