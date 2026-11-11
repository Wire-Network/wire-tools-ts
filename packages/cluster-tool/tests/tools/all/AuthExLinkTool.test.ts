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
import { ethereumKeyPairFromWallet } from "@wireio/cluster-tool/utils"
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
/** Account whose Ethereum identity the EVM link cases bind. */
const EthereumAccount = "batchop.b"

/** The authex `createlink` message the tool signs for an EVM link (its documented format). */
function evmLinkMessage(publicKey: string, nonce: number): string {
  return `${publicKey}|${EthereumAccount}|${ChainKind.EVM}|${nonce}|createlink auth`
}

/** The keccak256 digest of an EVM link message — what the signer is handed. */
function evmLinkDigest(publicKey: string, nonce: number): Uint8Array {
  return ethers.getBytes(
    ethers.keccak256(ethers.toUtf8Bytes(evmLinkMessage(publicKey, nonce)))
  )
}

/**
 * An ASYNC signer double of the KMS signer's shape — records every digest it is
 * handed and the hex signature it returned, delegating the signing to `wallet`.
 * Only `signMessage` exists on it, which is all the link ever calls.
 */
function recordingSigner(wallet: ethers.HDNodeWallet) {
  const digests: Uint8Array[] = [],
    signatures: string[] = [],
    signer = {
      signMessage: async (message: Uint8Array): Promise<string> => {
        digests.push(message)
        const signature = await wallet.signMessage(message)
        signatures.push(signature)
        return signature
      }
    } as unknown as ethers.Signer
  return { signer, digests, signatures }
}

describe("AuthExLinkTool", () => {
  describe("createLink", () => {
    afterEach(() => jest.restoreAllMocks())

    /** A wire client whose authex `createlink` invoke is captured. */
    function capturedAuthex() {
      const wire = fixtureContext().wire,
        contract = wire.getSysioContract(
          SysioContracts.SysioContractName.authex
        ),
        invoke = jest
          .spyOn(contract.actions.createlink, "invoke")
          .mockResolvedValue(null)
      jest.spyOn(wire, "getSysioContract").mockReturnValue(contract)
      return { wire, invoke }
    }

    it("signs the EVM link with the supplied (async) signer over the keccak digest, taking the public key from the params", async () => {
      const { wire, invoke } = capturedAuthex(),
        wallet = ethers.Wallet.createRandom(),
        pair = ethereumKeyPairFromWallet(wallet),
        { signer, digests, signatures } = recordingSigner(wallet)

      await AuthExLinkTool.createLink(wire, {
        chainKind: ChainKind.EVM,
        account: EthereumAccount,
        publicKey: pair.publicKey,
        signer
      })

      expect(invoke).toHaveBeenCalledTimes(1)
      const [data, options] = invoke.mock.calls[0],
        nonce = Number(data.nonce)
      expect(data).toMatchObject({
        account: EthereumAccount,
        chain_kind: SysioContracts.SysioAuthexChainkind.CHAIN_KIND_EVM,
        pub_key: pair.publicKey
      })
      // The signer was AWAITED over exactly the message digest…
      expect(digests).toEqual([evmLinkDigest(pair.publicKey, nonce)])
      // …its signature is what was submitted, re-encoded as a WIRE EM signature…
      expect(data.sig).toBe(Signature.fromHex(signatures[0], KeyType.EM).toString())
      expect(Signature.from(data.sig).type).toBe(KeyType.EM)
      // …and it recovers to the signer's own address.
      expect(ethers.verifyMessage(digests[0], signatures[0])).toBe(wallet.address)
      expect(options).toEqual({
        authorization: [{ actor: EthereumAccount, permission: "active" }]
      })
    })

    it("accepts a plain ethers.Wallet as the signer (the local-custody form) — same signature as the wallet's own", async () => {
      const { wire, invoke } = capturedAuthex(),
        wallet = ethers.Wallet.createRandom(),
        pair = ethereumKeyPairFromWallet(wallet)
      await AuthExLinkTool.createLink(wire, {
        chainKind: ChainKind.EVM,
        account: EthereumAccount,
        publicKey: pair.publicKey,
        signer: wallet
      })
      const [data] = invoke.mock.calls[0],
        expected = await wallet.signMessage(
          evmLinkDigest(pair.publicKey, Number(data.nonce))
        )
      expect(data.sig).toBe(Signature.fromHex(expected, KeyType.EM).toString())
    })

    it("never derives the public key from the signer — a material-less signer links the key the params name", async () => {
      const { wire, invoke } = capturedAuthex(),
        keyWallet = ethers.Wallet.createRandom(),
        pair = ethereumKeyPairFromWallet(keyWallet),
        // The signer is for a DIFFERENT wallet: the submitted pub_key still comes from the params.
        { signer } = recordingSigner(ethers.Wallet.createRandom())
      await AuthExLinkTool.createLink(wire, {
        chainKind: ChainKind.EVM,
        account: EthereumAccount,
        publicKey: pair.publicKey,
        signer
      })
      expect(invoke.mock.calls[0][0].pub_key).toBe(pair.publicKey)
    })

    it("propagates an EVM signer refusal before invoking the contract", async () => {
      const { wire, invoke } = capturedAuthex(),
        pair = ethereumKeyPairFromWallet(ethers.Wallet.createRandom()),
        failure = new Error("KMS signer refused"),
        signer = {
          signMessage: async () => {
            throw failure
          }
        } as unknown as ethers.Signer
      await expect(
        AuthExLinkTool.createLink(wire, {
          chainKind: ChainKind.EVM,
          account: EthereumAccount,
          publicKey: pair.publicKey,
          signer
        })
      ).rejects.toBe(failure)
      expect(invoke).not.toHaveBeenCalled()
    })

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
