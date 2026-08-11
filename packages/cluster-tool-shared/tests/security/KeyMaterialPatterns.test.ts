import { KeyType, PrivateKey } from "@wireio/sdk-core"
import {
  findKeyMaterial,
  KeyMaterialPatterns,
  KeySpecPatterns,
  RedactedKeyMarker
} from "@wireio/cluster-tool-shared"

/** anvil account #0's PUBLISHED private key — a real 0x + 64-hex secret. */
const AnvilAccountZeroPrivateKey =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
/** anvil's PUBLISHED 12-word BIP-39 mnemonic. */
const AnvilMnemonic =
  "test test test test test test test test test test test junk"

/** The pattern names, so a test names what it expects rather than an index. */
function names(): string[] {
  return KeyMaterialPatterns.map(entry => entry.name)
}

describe("KeyMaterialPatterns", () => {
  it("declares exactly the six secret encodings, each with a distinct name", () => {
    expect(KeyMaterialPatterns).toHaveLength(6)
    expect(new Set(names()).size).toBe(6)
  })

  describe("findKeyMaterial detects every secret encoding", () => {
    it("a WIRE canonical PVT_ private key (every curve)", () => {
      const wireCanonical = [
        PrivateKey.generate(KeyType.K1).toString(),
        PrivateKey.generate(KeyType.ED).toString(),
        PrivateKey.regenerate(
          KeyType.BLS,
          new Uint8Array(32).fill(7)
        ).toString()
      ]
      wireCanonical.forEach(privateKey =>
        expect(findKeyMaterial(`{"privateKey":"${privateKey}"}`)).not.toHaveLength(0)
      )
    })

    it("a wallet import format (WIF) K1 secret — K1's chain-native form", () => {
      const wif = PrivateKey.generate(KeyType.K1).toWif()
      // 51 chars, `5` then H/J/K — the 0x80-versioned base58check shape.
      expect(wif).toMatch(/^5[HJK]/)
      expect(wif).toHaveLength(51)
      expect(findKeyMaterial(`{"privateKey":"${wif}"}`)).not.toHaveLength(0)
    })

    it("a 0x-prefixed 32-byte hex secret — EM's chain-native form", () => {
      expect(
        findKeyMaterial(`{"key":"${AnvilAccountZeroPrivateKey}"}`)
      ).not.toHaveLength(0)
    })

    it("a base58 64-byte ed25519 secret — ED's chain-native form", () => {
      const native = PrivateKey.generate(KeyType.ED).toNativeString()
      expect(findKeyMaterial(`{"key":"${native}"}`)).not.toHaveLength(0)
    })

    it("a 64-element JSON byte array (a solana-keygen keypair file)", () => {
      const bytes = JSON.stringify(
        Array.from({ length: 64 }, (_unused, index) => index)
      )
      expect(findKeyMaterial(bytes)).not.toHaveLength(0)
    })

    it("a BIP-39 mnemonic phrase (12 and 24 words)", () => {
      expect(findKeyMaterial(AnvilMnemonic)).not.toHaveLength(0)
      expect(
        findKeyMaterial(`${AnvilMnemonic} ${AnvilMnemonic}`)
      ).not.toHaveLength(0)
    })
  })

  describe("findKeyMaterial leaves NON-secret material alone", () => {
    it("public keys, an ethereum address and SSM refs are clean", () => {
      const k1 = PrivateKey.generate(KeyType.K1),
        ed = PrivateKey.generate(KeyType.ED),
        bls = PrivateKey.regenerate(KeyType.BLS, new Uint8Array(32).fill(3)),
        // The exact shape an SSM-mode `cluster-keys.json` record carries.
        refsOnly = JSON.stringify({
          nodes: [
            {
              index: 0,
              k1: {
                type: KeyType.K1,
                publicKey: k1.toPublic().toString(),
                awsSecretId: "/wire/test/node_00/K1"
              },
              bls: {
                type: KeyType.BLS,
                publicKey: bls.toPublic().toString(),
                proofOfPossession: bls.proofOfPossessionString,
                awsSecretId: "/wire/test/node_00/BLS"
              }
            }
          ],
          operators: [
            {
              label: "batchop.a",
              account: "wireno.x3f9k",
              solana: {
                type: KeyType.ED,
                publicKey: ed.toPublic().toString(),
                awsSecretId: "/wire/test/batchop.a/ED"
              },
              ethereum: {
                type: KeyType.EM,
                publicKey: "PUB_EM_02a1b2c3",
                address: "0xabc0000000000000000000000000000000000a",
                awsSecretId: "/wire/test/batchop.a/EM"
              }
            }
          ]
        })
      expect(findKeyMaterial(refsOnly)).toEqual([])
    })

    it("an empty document is clean", () => {
      expect(findKeyMaterial("{}")).toEqual([])
    })
  })

  it("names the signature it matched, so a scanner can quote it", () => {
    const matched = findKeyMaterial(AnvilAccountZeroPrivateKey)
    expect(matched.map(entry => entry.name)).toContain(
      "0x-prefixed 32-byte hex private key"
    )
  })

  describe("KeySpecPatterns — the LOG set", () => {
    /** A `--signature-provider` spec whose key half is `key`. */
    const spec = (key: string) => `signature-provider = n,wire,wire,PUB,KEY:${key},`

    // A log's secrets only ever appear as a spec's key half — but that half is
    // a DIFFERENT encoding per curve, so matching one of them is not matching
    // the set. Measured on a real cluster log: `KEY:0x` alone caught 5 of 19.
    it.each([
      ["WIRE K1", "PVT_K1_2bfGi9rYsXQSXXTvJbDAPhHLQUojjaNLzVzsPaZBAmY5B8Q3Vd"],
      ["BLS finality", "PVT_BLS_qLZAiFhWQm3RLtWkPqjbP3ihgjnHrHZ4CXqLmDkJlsHNxHFOK"],
      ["Ethereum EM", "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"],
      ["Solana ED (bare base58)", "34gGB7U7ZgAC5s46VTkHj3E1sfBRWxTLuUHtRcTNBqRtLKZ8VoZFnR9sJ6vFhKtN"]
    ])("catches an unredacted %s key", (_curve, key) => {
      expect(findKeyMaterial(spec(key), KeySpecPatterns)).toHaveLength(1)
    })

    // The collector rewrites secrets to `KEY:<redacted>`. Without the marker
    // exclusion the set flags its OWN output — 19 hits on a real log whose
    // every secret had been successfully removed.
    it("does NOT flag a spec the collector already redacted", () => {
      expect(
        findKeyMaterial(spec(RedactedKeyMarker), KeySpecPatterns)
      ).toEqual([])
    })

    // Why this set exists: on one real cluster-create log the artifact set
    // reported 1049 naked-hex hits, of which 800 were block hashes, 162
    // transaction hashes and 50 anvil's published constants — none secret.
    it.each([
      ["a block hash", "Block Hash: 0x9d9031e97dd78ff8c15aa86939de9b1e791066a0224e331bc962a2099a7b1f04"],
      ["a transaction hash", "Transaction: 0xeef89eb907aa1e8757a7d92ef22efa4081596be39d32a96e55f29ea177738c5d"],
      ["prose that looks like a mnemonic", "the cluster will now start and then wait until every single node has fully joined"]
    ])("ignores %s in a log", (_what, line) => {
      expect(findKeyMaterial(line, KeySpecPatterns)).toEqual([])
    })

    // The artifact set stays the gate for PERSISTED shapes: a bare `PVT_…` with
    // no spec around it is exactly what must never ship inside a tarball, and
    // the log set cannot see it. Narrowing one must never narrow the other.
    it("the ARTIFACT set still catches a bare key the log set cannot", () => {
      const bare = "PVT_K1_2bfGi9rYsXQSXXTvJbDAPhHLQUojjaNLzVzsPaZBAmY5B8Q3Vd"
      expect(findKeyMaterial(bare, KeySpecPatterns)).toEqual([])
      expect(findKeyMaterial(bare, KeyMaterialPatterns).length).toBeGreaterThan(0)
    })

    it("defaults to the artifact set when no set is named", () => {
      const bare = "PVT_K1_2bfGi9rYsXQSXXTvJbDAPhHLQUojjaNLzVzsPaZBAmY5B8Q3Vd"
      expect(findKeyMaterial(bare)).toEqual(findKeyMaterial(bare, KeyMaterialPatterns))
    })
  })
})
