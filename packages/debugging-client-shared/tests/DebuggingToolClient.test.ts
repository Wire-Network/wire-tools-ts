import { DebuggingToolClient } from "@wire-e2e-tests/debugging-client-shared"

describe("DebuggingToolClient", () => {
   it("exposes DefaultHost and DefaultPort namespace constants", () => {
      expect(typeof DebuggingToolClient.DefaultHost).toBe("string")
      expect(typeof DebuggingToolClient.DefaultPort).toBe("number")
      expect(DebuggingToolClient.DefaultHost).toBe("127.0.0.1")
      expect(DebuggingToolClient.DefaultPort).toBe(9876)
   })

   it("rejects create() when server is not reachable", async () => {
      await expect(
         DebuggingToolClient.create({ baseUrl: "http://127.0.0.1:1" })
      ).rejects.toThrow()
   })
})
