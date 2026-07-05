import { AuthExLinkTool } from "@wireio/cluster-tool/tools/all"

describe("AuthExLinkTool", () => {
  // EM key derivation moved to keyPairUtils (see keyPairUtils.test.ts); this tool
  // retains authex link creation + the throwaway-depositor pubkey helper.
  describe("newEthereumPubEm", () => {
    it("returns a PUB_EM_ key that differs across calls (random wallet)", () => {
      const a = AuthExLinkTool.newEthereumPubEm()
      const b = AuthExLinkTool.newEthereumPubEm()
      expect(a).toMatch(/^PUB_EM_/)
      expect(b).toMatch(/^PUB_EM_/)
      expect(a).not.toBe(b)
    })
  })
})
