import { ethers } from "ethers"

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

  describe("newEthereumIdentity", () => {
    it("returns a matching PUB_EM_ key and canonical lowercase native address", () => {
      const identity = AuthExLinkTool.newEthereumIdentity(),
        compressedPublicKey = `0x${identity.publicKey.replace(/^PUB_EM_/, "")}`,
        expectedAddress = ethers
          .computeAddress(compressedPublicKey)
          .slice(2)
          .toLowerCase()

      expect(identity.publicKey).toMatch(/^PUB_EM_[0-9a-f]{66}$/i)
      expect(identity.nativeAddress).toMatch(/^[0-9a-f]{40}$/)
      expect(identity.nativeAddress).toBe(expectedAddress)
    })
  })
})
