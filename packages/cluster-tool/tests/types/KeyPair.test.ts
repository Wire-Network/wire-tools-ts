import { KeyType } from "@wireio/sdk-core"
import type {
  EthereumKeyPair,
  WireFinalizerKeyPair,
  SolanaKeyPair,
  WireKeyPair
} from "@wireio/cluster-tool/types/KeyPair"

describe("KeyPair", () => {
  it("models a curve-tagged K1 (WIRE) key pair", () => {
    const wire: WireKeyPair = {
      type: KeyType.K1,
      publicKey: "PUB_K1_sample",
      privateKey: "PVT_K1_sample"
    }
    expect(wire.type).toBe(KeyType.K1)
    expect(wire.publicKey).toBe("PUB_K1_sample")
  })

  it("compile-enforces a proof of possession on BLS (finalizer) pairs", () => {
    const finalizer: WireFinalizerKeyPair = {
      type: KeyType.BLS,
      publicKey: "PUB_BLS_sample",
      privateKey: "PVT_BLS_sample",
      proofOfPossession: "SIG_BLS_sample"
    }
    expect(finalizer.proofOfPossession).toBe("SIG_BLS_sample")
  })

  it("models the EM (Ethereum) and ED (Solana) curve tags", () => {
    const ethereum: EthereumKeyPair = {
      type: KeyType.EM,
      publicKey: "PUB_EM_sample",
      privateKey: "PVT_EM_sample",
      address: "0x0000000000000000000000000000000000000001"
    }
    const solana: SolanaKeyPair = {
      type: KeyType.ED,
      publicKey: "PUB_ED_sample",
      privateKey: "PVT_ED_sample"
    }
    expect(ethereum.type).toBe(KeyType.EM)
    expect(ethereum.address).toBe("0x0000000000000000000000000000000000000001")
    expect(solana.type).toBe(KeyType.ED)
  })

  it("compile-enforces the 0x address on EM (Ethereum) pairs", () => {
    // @ts-expect-error EM pairs require `address` (via the KeyPair<EM> conditional)
    const missingAddress: EthereumKeyPair = {
      type: KeyType.EM,
      publicKey: "PUB_EM_sample",
      privateKey: "PVT_EM_sample"
    }
    expect(missingAddress.type).toBe(KeyType.EM)
  })
})
