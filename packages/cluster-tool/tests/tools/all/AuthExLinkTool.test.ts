import { ethers } from "ethers"
import nacl from "tweetnacl"

import { ChainKind } from "@wireio/opp-typescript-models"
import type * as SDK from "@wireio/sdk-core" with {
  "resolution-mode": "require"
}
import type * as Authex from "@wireio/sdk-core/contracts/sysio/authex/index" with {
  "resolution-mode": "require"
}

import { AuthExLinkTool } from "@wireio/cluster-tool/tools/all"
import { fixtureContext } from "../../config/clusterBuildContextFixture.js"

// These CJS tests use the same SDK declaration branch as the built tool.
const {
    Bytes,
    KeyType,
    PrivateKey,
    Signature,
    SysioContracts
  }: typeof SDK = require("@wireio/sdk-core"),
  {
    prepareCreateLink
  }: typeof Authex = require("@wireio/sdk-core/contracts/sysio/authex/index")

/** Account whose Solana identity is linked by the bootstrap regression. */
const SolanaAccount = "batchop.a"

describe("AuthExLinkTool", () => {
  describe("createLink", () => {
    afterEach(() => jest.restoreAllMocks())

    it("submits the SDK's composed Solana signature without prepending another public key", async () => {
      const wire = fixtureContext().wire,
        contract = wire.getSysioContract(
          SysioContracts.SysioContractName.authex
        ),
        invoke = jest
          .spyOn(contract.actions.createlink, "invoke")
          .mockResolvedValue(null),
        privateKey = PrivateKey.generate(KeyType.ED),
        publicKey = privateKey.toPublic()
      jest.spyOn(wire, "getSysioContract").mockReturnValue(contract)

      await AuthExLinkTool.createLink(wire, {
        chainKind: ChainKind.SVM,
        account: SolanaAccount,
        privateKey
      })

      expect(invoke).toHaveBeenCalledTimes(1)
      const [data, options] = invoke.mock.calls[0],
        signature = Signature.from(data.sig),
        prepared = prepareCreateLink({
          account: SolanaAccount,
          publicKey,
          chainKind: SysioContracts.SysioAuthexChainkind.CHAIN_KIND_SVM,
          nonce: Number(data.nonce)
        })

      expect(data).toMatchObject({
        account: SolanaAccount,
        chain_kind: prepared.chainKind,
        pub_key: publicKey.toString()
      })
      expect(signature.type).toBe(KeyType.ED)
      expect(signature.data.array).toHaveLength(
        nacl.sign.publicKeyLength + nacl.sign.signatureLength
      )
      expect(
        signature.data.array.subarray(0, nacl.sign.publicKeyLength)
      ).toEqual(publicKey.data.array)
      expect(
        signature.verifyMessage(Bytes.from(prepared.signingPayload), publicKey)
      ).toBe(true)
      expect(options).toEqual({
        authorization: [{ actor: SolanaAccount, permission: "active" }]
      })
    })

    it("propagates a Solana signer refusal before invoking the contract", async () => {
      const wire = fixtureContext().wire,
        contract = wire.getSysioContract(
          SysioContracts.SysioContractName.authex
        ),
        invoke = jest
          .spyOn(contract.actions.createlink, "invoke")
          .mockResolvedValue(null),
        privateKey = PrivateKey.generate(KeyType.ED),
        failure = new Error("Solana signer refused")
      jest.spyOn(wire, "getSysioContract").mockReturnValue(contract)
      jest.spyOn(privateKey, "signMessage").mockImplementation(() => {
        throw failure
      })

      await expect(
        AuthExLinkTool.createLink(wire, {
          chainKind: ChainKind.SVM,
          account: SolanaAccount,
          privateKey
        })
      ).rejects.toBe(failure)
      expect(invoke).not.toHaveBeenCalled()
    })
  })

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
