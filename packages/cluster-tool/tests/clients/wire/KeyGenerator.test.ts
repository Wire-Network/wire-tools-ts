import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { ethers } from "ethers"
import { KeyType } from "@wireio/sdk-core"
import { SignatureProviderType } from "@wireio/cluster-tool-shared"
import { KeyGenerator } from "@wireio/cluster-tool/clients/wire"

const K1_OUTPUT =
  "Private key: PVT_K1_2bfGi9rYsXQSXXTvJbDAPhHLQUojjaNLomdm3cEJ1XTdfThJ4i\n" +
  "Public key: PUB_K1_6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV"
const BLS_OUTPUT =
  "Private key: PVT_BLS_abc123\n" +
  "Public key: PUB_BLS_def456\n" +
  "Proof of Possession: SIG_BLS_ghi789"
/** anvil's deterministic mnemonic — HD-derived EM wallets are stable + well-known. */
const AnvilMnemonic = "test test test test test test test test test test test junk"

describe("KeyGenerator", () => {
  let dir: string
  beforeAll(() => {
    dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "keygen-"))
  })
  afterAll(() => {
    Fs.rmSync(dir, { recursive: true, force: true })
  })

  /** An executable shell script that prints `stdout` regardless of its args. */
  function fakeBinary(name: string, stdout: string): string {
    const file = Path.join(dir, name)
    Fs.writeFileSync(file, `#!/bin/sh\ncat <<'KEYEOF'\n${stdout}\nKEYEOF\n`)
    Fs.chmodSync(file, 0o755)
    return file
  }

  /** A Context whose clio/sys-util are fake scripts; EM uses the anvil mnemonic. */
  function context(k1Stdout: string = K1_OUTPUT, blsStdout: string = BLS_OUTPUT): KeyGenerator.Context {
    return {
      clio: fakeBinary("clio", k1Stdout),
      sysUtil: fakeBinary("sys-util", blsStdout),
      ethereumMnemonic: ethers.Mnemonic.fromPhrase(AnvilMnemonic)
    }
  }

  it("create(K1) parses clio output into a tagged WireKeyPair", async () => {
    const keys = await KeyGenerator.create(KeyType.K1, context())
    expect(keys.type).toBe(KeyType.K1)
    expect(keys.publicKey).toMatch(/^PUB_K1_/)
    expect(keys.privateKey).toMatch(/^PVT_K1_/)
  })

  it("create(BLS) parses sys-util output incl. proof of possession", async () => {
    const keys = await KeyGenerator.create(KeyType.BLS, context())
    expect(keys.type).toBe(KeyType.BLS)
    expect(keys.publicKey).toBe("PUB_BLS_def456")
    expect(keys.privateKey).toBe("PVT_BLS_abc123")
    expect(keys.proofOfPossession).toBe("SIG_BLS_ghi789")
  })

  it("create(ED) generates a fresh tagged SolanaKeyPair (no external process)", async () => {
    const keys = await KeyGenerator.create(KeyType.ED, context())
    expect(keys.type).toBe(KeyType.ED)
    expect(keys.publicKey).toMatch(/^PUB_ED_/)
    expect(keys.privateKey).toMatch(/^PVT_ED_/)
    const other = await KeyGenerator.create(KeyType.ED, context())
    expect(other.publicKey).not.toBe(keys.publicKey) // fresh each call
  })

  it("create(EM, {ethereumHdIndex}) derives a deterministic EthereumKeyPair (carrying its address)", async () => {
    const ctx = context()
    const keys = await KeyGenerator.create(KeyType.EM, ctx, { ethereumHdIndex: 5 })
    expect(keys.type).toBe(KeyType.EM)
    expect(keys.publicKey).toMatch(/^PUB_EM_/)
    expect(keys.privateKey).toMatch(/^PVT_EM_/)
    expect(keys.address).toMatch(/^0x/)
    // deterministic for the same HD index; distinct index → distinct key
    const again = await KeyGenerator.create(KeyType.EM, ctx, { ethereumHdIndex: 5 })
    expect(again.address).toBe(keys.address)
    const other = await KeyGenerator.create(KeyType.EM, ctx, { ethereumHdIndex: 6 })
    expect(other.address).not.toBe(keys.address)
  })

  it("create(EM) requires an ethereumHdIndex", async () => {
    await expect(KeyGenerator.create(KeyType.EM, context())).rejects.toThrow(
      /ethereumHdIndex is required/
    )
  })

  it("createProducerKeySet returns both K1 + BLS pairs", async () => {
    const set = await KeyGenerator.createProducerKeySet(context())
    expect(set.k1.type).toBe(KeyType.K1)
    expect(set.bls.type).toBe(KeyType.BLS)
    expect(set.bls.proofOfPossession).toBe("SIG_BLS_ghi789")
  })

  it("throws a parse error on unrecognized clio output", async () => {
    await expect(
      KeyGenerator.create(KeyType.K1, context("no keys here"))
    ).rejects.toThrow(/Failed to parse K1 private key/)
  })

  it("toSignatureProvider formats WIRE (K1/BLS) nodeop specs via one generic entry", () => {
    expect(
      KeyGenerator.toSignatureProvider({
        type: KeyType.K1,
        publicKey: "PUB_K1_p",
        privateKey: "PVT_K1_s"
      })
    ).toBe("wire-PUB_K1_p,wire,wire,PUB_K1_p,KEY:PVT_K1_s")
    expect(
      KeyGenerator.toSignatureProvider({
        type: KeyType.BLS,
        publicKey: "PUB_BLS_p",
        privateKey: "PVT_BLS_s",
        proofOfPossession: "SIG_BLS_x"
      })
    ).toBe("wire-bls-PUB_BLS_p,wire,wire_bls,PUB_BLS_p,KEY:PVT_BLS_s")
  })

  it("toSignatureProvider formats an EM (ethereum outpost) spec — uncompressed pub + 0x-hex native key", async () => {
    const ethereum = await KeyGenerator.create(KeyType.EM, context(), { ethereumHdIndex: 1 })
    const spec = KeyGenerator.toSignatureProvider(ethereum, "eth-batchopaaaa")
    const [name, chain, keyTag, publicKey, keyField] = spec.split(",")
    expect(name).toBe("eth-batchopaaaa")
    expect(chain).toBe("ethereum")
    expect(keyTag).toBe("ethereum")
    // 64-byte uncompressed key: 0x + 128 hex, WITHOUT the 04 marker
    expect(publicKey).toMatch(/^0x[0-9a-fA-F]{128}$/)
    expect(keyField).toMatch(/^KEY:0x[0-9a-f]{64}$/)
  })

  it("toSignatureProvider formats an ED (solana outpost) spec — base58 pub + base58 secret", async () => {
    const solana = await KeyGenerator.create(KeyType.ED, context())
    const spec = KeyGenerator.toSignatureProvider(solana, "sol-batchopaaaa")
    const [name, chain, keyTag, publicKey, keyField] = spec.split(",")
    expect(name).toBe("sol-batchopaaaa")
    expect(chain).toBe("solana")
    expect(keyTag).toBe("solana")
    expect(publicKey).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
    expect(keyField).toMatch(/^KEY:[1-9A-HJ-NP-Za-km-z]{80,90}$/)
  })

  it("toSignatureProvider asserts a providerName for EM/ED specs", async () => {
    const solana = await KeyGenerator.create(KeyType.ED, context())
    expect(() => KeyGenerator.toSignatureProvider(solana)).toThrow(
      /providerName is required for ED providers/
    )
  })

  it("exposes typed dev bios keys", () => {
    expect(KeyGenerator.BiosK1Key.type).toBe(KeyType.K1)
    expect(KeyGenerator.BiosK1Key.publicKey.length).toBeGreaterThan(0)
    expect(KeyGenerator.BiosK1Key.privateKey.length).toBeGreaterThan(0)
    expect(KeyGenerator.BiosBLSKey.type).toBe(KeyType.BLS)
    expect(KeyGenerator.BiosBLSKey.publicKey).toMatch(/^PUB_BLS_/)
    expect(KeyGenerator.BiosBLSKey.proofOfPossession).toMatch(/^SIG_BLS_/)
  })

  it("toSignatureProvider renders SSM: / KIOD: segments per the provider source", () => {
    const pair = {
      type: KeyType.K1,
      publicKey: "PUB_K1_p",
      privateKey: "PVT_K1_s"
    }
    const ssmSource = KeyGenerator.keySource(
      {
        type: SignatureProviderType.SSM,
        ssm: { awsRegion: "us-east-1", awsSecretIdPattern: "p" }
      },
      "/wire/batchop1/K1",
      "http://kiod"
    )
    expect(KeyGenerator.toSignatureProvider(pair, undefined, ssmSource)).toBe(
      "wire-PUB_K1_p,wire,wire,PUB_K1_p,SSM:us-east-1:/wire/batchop1/K1"
    )
    const kiodSource = KeyGenerator.keySource(
      { type: SignatureProviderType.KIOD, ssm: null },
      "unused",
      "http://127.0.0.1:8900"
    )
    expect(KeyGenerator.toSignatureProvider(pair, undefined, kiodSource)).toBe(
      "wire-PUB_K1_p,wire,wire,PUB_K1_p,KIOD:http://127.0.0.1:8900"
    )
  })

  it("keySource selects the KEY default source for a KEY provider config", () => {
    expect(
      KeyGenerator.keySource(
        { type: SignatureProviderType.KEY, ssm: null },
        "s",
        "u"
      )
    ).toEqual(KeyGenerator.DefaultKeySource)
  })
})

describe("keygen extra records", () => {
  it("create(ED) records an sdk-core keygen entry with purpose + full pair", async () => {
    const { StepExtraRecorder } = await import("@wireio/cluster-tool/report")
    const context = KeyGenerator.context("/usr/bin/clio", "/build", AnvilMnemonic)
    const recorder = new StepExtraRecorder()
    const pair = await StepExtraRecorder.runWith(recorder, () =>
      KeyGenerator.create(KeyType.ED, context, { purpose: "operator x — solana key" })
    )
    expect(recorder.calls).toEqual([
      {
        client: "sdk-core",
        kind: "keygen",
        keyType: "ED",
        purpose: "operator x — solana key",
        keyPair: { type: KeyType.ED, publicKey: pair.publicKey, privateKey: pair.privateKey }
      }
    ])
  })

  it("create(EM) records the ethers derivation path", async () => {
    const { StepExtraRecorder } = await import("@wireio/cluster-tool/report")
    const context = KeyGenerator.context("/usr/bin/clio", "/build", AnvilMnemonic)
    const recorder = new StepExtraRecorder()
    await StepExtraRecorder.runWith(recorder, () =>
      KeyGenerator.create(KeyType.EM, context, { ethereumHdIndex: 3 })
    )
    expect(recorder.calls[0].client).toBe("ethers")
    expect(recorder.calls[0].derivation).toBe(`${KeyGenerator.EthereumDerivationPath}3`)
    expect(recorder.calls[0].purpose).toBeNull()
  })
})
