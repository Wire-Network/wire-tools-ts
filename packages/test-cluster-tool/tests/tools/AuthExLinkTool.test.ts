import "jest"
import { ethers } from "ethers"
import nacl from "tweetnacl"
import { Bytes, KeyType, PrivateKey, Signature } from "@wireio/sdk-core"
import { ChainKind } from "@wireio/opp-typescript-models"
import { createAuthExLink, type Clio } from "@wireio/test-cluster-tool"

/**
 * The authex SVM signing convention, mirrored from the contract + libfc:
 * the contract maps sha256(message) into printable ASCII [33..126] and
 * `assert_recover_key`s those 32 bytes; the chain's unified ED25519
 * verification checks the signature over the LOWERCASE-HEX encoding of
 * that digest (Phantom guard rails — wallets sign displayable strings).
 */
function expectedHexPayload(message: string): Uint8Array {
  const hashBytes = ethers.getBytes(ethers.sha256(ethers.toUtf8Bytes(message)))
  const mapped = new Uint8Array(hashBytes.length)
  hashBytes.forEach((b, i) => {
    mapped[i] = 33 + (b % 94)
  })
  return ethers.toUtf8Bytes(ethers.hexlify(mapped).slice(2))
}

describe("AuthExLinkTool — SVM (ED25519) createlink signing", () => {
  const account = "linktester"

  /**
   * The tool's own `privateKey` parameter type. The tests project and the
   * src project resolve `@wireio/sdk-core` through different package-export
   * conditions (lib/esm vs lib/cjs declarations) — structurally identical,
   * nominally distinct (the dual-package hazard). Deriving the slot type
   * from the function keeps the cast honest and runtime-free.
   */
  type LinkPrivateKey = Parameters<typeof createAuthExLink>[1]["privateKey"]

  /** Captures the action payload `createAuthExLink` pushes through clio. */
  function clioStub(captured: { data?: any }): Clio {
    return {
      pushActionAndWait: jest.fn(
        async (_code: string, _action: string, data: any) => {
          captured.data = data
        }
      )
    } as unknown as Clio
  }

  test("signs the lowercase-hex encoding of the mapped digest (chain-verifiable)", async () => {
    const keypair = nacl.sign.keyPair()
    const privateKey = PrivateKey.regenerate(
      KeyType.ED,
      Bytes.from(keypair.secretKey)
    )

    const captured: { data?: any } = {}
    await createAuthExLink(clioStub(captured), {
      chainKind: ChainKind.SVM,
      account,
      privateKey: privateKey as unknown as LinkPrivateKey
    })

    expect(captured.data).toBeDefined()
    const { pub_key, sig, nonce, chain_kind } = captured.data
    expect(chain_kind).toBe(ChainKind.SVM)

    // Rebuild the exact contract-side message and its signed payload.
    const message = `${pub_key}|${account}|${ChainKind.SVM}|${nonce}|createlink auth`
    const payload = expectedHexPayload(message)

    // Wire ED signatures are 96 bytes: 32-byte embedded pubkey + 64-byte sig.
    const sigBytes = Signature.from(sig).data.array
    expect(sigBytes.length).toBe(96)
    expect(Buffer.from(sigBytes.slice(0, 32))).toEqual(
      Buffer.from(keypair.publicKey)
    )

    // The signature must verify over the HEX payload — the convention the
    // chain's `ed::signature_shim::verify` enforces. (A signature over the
    // raw mapped bytes — the pre-2026-06-09 convention — must fail.)
    expect(
      nacl.sign.detached.verify(payload, sigBytes.slice(32), keypair.publicKey)
    ).toBe(true)

    const rawMapped = ethers.getBytes(
      ethers.sha256(ethers.toUtf8Bytes(message))
    ).map(b => 33 + (b % 94))
    expect(
      nacl.sign.detached.verify(
        Uint8Array.from(rawMapped),
        sigBytes.slice(32),
        keypair.publicKey
      )
    ).toBe(false)
  })
})
