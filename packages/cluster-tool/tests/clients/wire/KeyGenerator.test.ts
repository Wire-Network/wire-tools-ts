import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { ethers } from "ethers"
import { KeyType, PrivateKey } from "@wireio/sdk-core"
import {
  SignatureProviderKeyPolicy,
  SignatureProviderType
} from "@wireio/cluster-tool-shared"
import { KeyGenerator } from "@wireio/cluster-tool/clients/wire"
import {
  ethereumKeyPairFromKmsPublicKey,
  ethereumPrivateKeyHex,
  ethereumSdkPrivateKey,
  ethereumUncompressedPublicKeyHex,
  solanaKeyPairFromKmsPublicKey,
  solanaSdkPrivateKey
} from "@wireio/cluster-tool/utils"

/** `sys-util` console output for a BLS generation — the one backend that still shells out. */
const BLS_OUTPUT =
  "Private key: PVT_BLS_abc123\n" +
  "Public key: PUB_BLS_def456\n" +
  "Proof of Possession: SIG_BLS_ghi789"

/**
 * A K1 pair a real `clio create key --k1 --to-console` produced. K1 generation
 * no longer shells out to clio, so this fixture is the PARITY proof: sdk-core's
 * derivation and its `PVT_K1_` / `PUB_K1_` encoding must reproduce clio's
 * public key from clio's private key exactly.
 */
const ClioK1Fixture = {
  privateKey: "PVT_K1_26dtEi6dMPNeCZHB7HKbT4BN5f6VYc96VfBD5Nq9jWyRxaTkNv",
  publicKey: "PUB_K1_88q65cbpw5hfCGFn51XJ1tfwWyWEEuXJXPmS4BFy6Ta4WXWDVF"
} as const

/** A build dir that holds NO binary — proves a backend touched no process. */
const BinaryLessBuildPath = "/nonexistent/build"

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

  /** A Context whose sys-util is a fake script — the ONLY tooling the facade needs. */
  function context(blsStdout: string = BLS_OUTPUT): KeyGenerator.Context {
    return { sysUtil: fakeBinary("sys-util", blsStdout) }
  }

  it("context(buildPath) names the build's sys-util and NOTHING else — no clio, no mnemonic", () => {
    const built = KeyGenerator.context("/build")
    expect(built).toEqual({
      sysUtil: Path.join("/build", KeyGenerator.SysUtilSubpath)
    })
    expect(Object.keys(built)).toEqual(["sysUtil"])
  })

  it("create(K1) mints a RANDOM tagged WireKeyPair through sdk-core — no process, distinct per call", async () => {
    const keys = await KeyGenerator.create(
      KeyType.K1,
      KeyGenerator.context(BinaryLessBuildPath)
    )
    expect(keys.type).toBe(KeyType.K1)
    expect(keys.publicKey).toMatch(/^PUB_K1_/)
    expect(keys.privateKey).toMatch(/^PVT_K1_/)
    // The public half IS the private half's derivation.
    expect(PrivateKey.from(keys.privateKey).toPublic().toString()).toBe(
      keys.publicKey
    )
    const other = await KeyGenerator.create(
      KeyType.K1,
      KeyGenerator.context(BinaryLessBuildPath)
    )
    expect(other.privateKey).not.toBe(keys.privateKey)
    expect(other.publicKey).not.toBe(keys.publicKey)
  })

  it("derives exactly the public key clio derives from a clio-minted K1 secret (PVT_K1_ / PUB_K1_ parity)", () => {
    // Pinned against a pair produced by the real `clio create key --k1
    // --to-console`: the sdk-core backend's secp256k1 derivation and its WIRE
    // prefixed encodings agree with clio's byte for byte.
    expect(PrivateKey.from(ClioK1Fixture.privateKey).toPublic().toString()).toBe(
      ClioK1Fixture.publicKey
    )
  })

  it("create(BLS) parses sys-util output incl. proof of possession", async () => {
    const keys = await KeyGenerator.create(KeyType.BLS, context())
    expect(keys.type).toBe(KeyType.BLS)
    expect(keys.publicKey).toBe("PUB_BLS_def456")
    expect(keys.privateKey).toBe("PVT_BLS_abc123")
    expect(keys.proofOfPossession).toBe("SIG_BLS_ghi789")
  })

  it("throws a parse error on unrecognized sys-util output", async () => {
    await expect(
      KeyGenerator.create(KeyType.BLS, context("no keys here"))
    ).rejects.toThrow(/Failed to parse BLS private key/)
  })

  it("create(ED) generates a fresh tagged SolanaKeyPair (no external process)", async () => {
    const keys = await KeyGenerator.create(
      KeyType.ED,
      KeyGenerator.context(BinaryLessBuildPath)
    )
    expect(keys.type).toBe(KeyType.ED)
    expect(keys.publicKey).toMatch(/^PUB_ED_/)
    expect(keys.privateKey).toMatch(/^PVT_ED_/)
    const other = await KeyGenerator.create(
      KeyType.ED,
      KeyGenerator.context(BinaryLessBuildPath)
    )
    expect(other.publicKey).not.toBe(keys.publicKey) // fresh each call
  })

  it("create(EM) mints a RANDOM EthereumKeyPair carrying its address — no mnemonic, no index, distinct per call", async () => {
    const keys = await KeyGenerator.create(
      KeyType.EM,
      KeyGenerator.context(BinaryLessBuildPath)
    )
    expect(keys.type).toBe(KeyType.EM)
    expect(keys.publicKey).toMatch(/^PUB_EM_/)
    expect(keys.privateKey).toMatch(/^PVT_EM_/)
    expect(keys.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
    // The address IS the stored secret's: the 0x secret the pair stores derives it.
    expect(ethers.computeAddress(ethereumPrivateKeyHex(keys))).toBe(keys.address)
    const other = await KeyGenerator.create(
      KeyType.EM,
      KeyGenerator.context(BinaryLessBuildPath)
    )
    expect(other.address).not.toBe(keys.address)
    expect(other.privateKey).not.toBe(keys.privateKey)
  })

  it("refuses a curve it has no backend for", async () => {
    await expect(
      KeyGenerator.create(KeyType.R1, KeyGenerator.context(BinaryLessBuildPath))
    ).rejects.toThrow(/unsupported key type/)
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
    const ethereum = await KeyGenerator.create(KeyType.EM, context())
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
        ssm: { awsSecretIdPattern: "p" },
        kms: null,
        batchOperatorKeyPolicy: SignatureProviderKeyPolicy.adoptOrCreate
      },
      "/wire/batchop1/K1",
      "http://kiod"
    )
    // REGION-LESS — ONE colon. `parse_ssm_spec` rejects `SSM::<param>` ("has
    // empty region; drop the leading ':'") and there is no primary region to
    // name, so the region resolves from the depot's AWS environment chain.
    expect(ssmSource).not.toHaveProperty("awsRegion")
    expect(KeyGenerator.toSignatureProvider(pair, undefined, ssmSource)).toBe(
      "wire-PUB_K1_p,wire,wire,PUB_K1_p,SSM:/wire/batchop1/K1"
    )
    const kiodSource = KeyGenerator.keySource(
      {
        type: SignatureProviderType.KIOD,
        ssm: null,
        kms: null,
        batchOperatorKeyPolicy: SignatureProviderKeyPolicy.adoptOrCreate
      },
      "unused",
      "http://127.0.0.1:8900"
    )
    expect(KeyGenerator.toSignatureProvider(pair, undefined, kiodSource)).toBe(
      "wire-PUB_K1_p,wire,wire,PUB_K1_p,KIOD:http://127.0.0.1:8900"
    )
  })

  it("toSignatureProvider asserts an SSM source carries its awsSecretId", () => {
    const pair = {
      type: KeyType.K1,
      publicKey: "PUB_K1_p",
      privateKey: "PVT_K1_s"
    }
    expect(() =>
      KeyGenerator.toSignatureProvider(pair, undefined, {
        type: SignatureProviderType.SSM
      })
    ).toThrow(/an SSM source requires awsSecretId/)
  })

  it("renders an SSM spec for a REFS-ONLY pair — no privateKey is ever touched", async () => {
    // What `ClusterState.loadKeys` rehydrates on an SSM cluster: publicKey +
    // awsSecretId, no key material. `wire-cluster-tool run` must still build
    // every daemon's --signature-provider from it.
    const ethereum = await KeyGenerator.create(KeyType.EM, context()),
      solana = await KeyGenerator.create(KeyType.ED, context()),
      ssmSource = KeyGenerator.keySource(
        {
          type: SignatureProviderType.SSM,
          ssm: { awsSecretIdPattern: "p" },
          kms: null,
          batchOperatorKeyPolicy: SignatureProviderKeyPolicy.adoptOrCreate
        },
        "/wire/test/batchop.a/EM",
        "http://kiod"
      )
    const ethereumRefsOnly = {
        type: KeyType.EM,
        publicKey: ethereum.publicKey,
        address: ethereum.address,
        awsSecretId: "/wire/test/batchop.a/EM"
      },
      solanaRefsOnly = {
        type: KeyType.ED,
        publicKey: solana.publicKey,
        awsSecretId: "/wire/test/batchop.a/ED"
      }
    const ethereumSpec = KeyGenerator.toSignatureProvider(
      ethereumRefsOnly,
      "eth-batchopaaaa",
      ssmSource
    )
    expect(ethereumSpec).toBe(
      KeyGenerator.toSignatureProvider(ethereum, "eth-batchopaaaa", ssmSource)
    )
    expect(ethereumSpec.endsWith(",SSM:/wire/test/batchop.a/EM")).toBe(true)
    const solanaSpec = KeyGenerator.toSignatureProvider(
      solanaRefsOnly,
      "sol-batchopaaaa",
      ssmSource
    )
    expect(solanaSpec).toBe(
      KeyGenerator.toSignatureProvider(solana, "sol-batchopaaaa", ssmSource)
    )
    // The base58 public key still renders — it comes off the STORED pair.
    expect(solanaSpec.split(",")[3]).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
  })

  it("keySource selects the KEY default source for a KEY provider config", () => {
    expect(
      KeyGenerator.keySource(
        {
          type: SignatureProviderType.KEY,
          ssm: null,
          kms: null,
          batchOperatorKeyPolicy: SignatureProviderKeyPolicy.adoptOrCreate
        },
        "s",
        "u"
      )
    ).toEqual(KeyGenerator.DefaultKeySource)
  })

  describe("the KMS source (an EM key custodied by AWS KMS)", () => {
    /** The ONE region a KMS key lives in, and the alias the harness renders. */
    const KmsRegion = "us-east-1",
      KmsAliasName = "alias/wire/test/batchop-a/EM",
      KmsSource: KeyGenerator.SignatureProviderSource = {
        type: SignatureProviderType.KMS,
        awsKmsRegion: KmsRegion,
        awsKmsKeyId: KmsAliasName
      }

    /** A KMS-custodied EM pair: the public identity + the key reference, NO material. */
    function kmsPair() {
      const wallet = ethers.Wallet.createRandom()
      return ethereumKeyPairFromKmsPublicKey(
        ethers.getBytes(
          ethers.SigningKey.computePublicKey(wallet.signingKey.publicKey, true)
        ),
        KmsRegion,
        KmsAliasName
      )
    }

    it("renders KMS:<region>:<alias> for an EM pair — the regional form nodeop's parse_kms_spec reads", () => {
      const pair = kmsPair(),
        spec = KeyGenerator.toSignatureProvider(pair, "eth-batchopaaaa", KmsSource),
        [name, chain, keyTag, publicKey, ...keyField] = spec.split(",")
      expect(name).toBe("eth-batchopaaaa")
      expect(chain).toBe("ethereum")
      expect(keyTag).toBe("ethereum")
      expect(publicKey).toBe(ethereumUncompressedPublicKeyHex(pair))
      // The segment carries its own colons (region:alias) — rejoined, it is the whole tail.
      expect(keyField.join(",")).toBe(`KMS:${KmsRegion}:${KmsAliasName}`)
    })

    it("NEVER evaluates key material for a KMS source — the pair has none to give", () => {
      // A KMS pair carries no privateKey; the EM material derivation throws on
      // it, so an eager `keyMaterial()` would crash this render.
      const pair = kmsPair()
      expect(pair).not.toHaveProperty("privateKey")
      expect(() => ethereumSdkPrivateKey(pair)).toThrow(/custodied by AWS KMS/)
      expect(() =>
        KeyGenerator.toSignatureProvider(pair, "eth-batchopaaaa", KmsSource)
      ).not.toThrow()
    })

    it("renders KMS:<region>:<alias> for an ED pair — <name>,solana,solana,<base58>,KMS:<region>:<alias>, the spec nodeop's Ed25519 KMS provider takes, with NO material read", () => {
      const solanaAliasName = "alias/wire/test/batchop-a/ED",
        edPrivate = PrivateKey.generate(KeyType.ED),
        pair = solanaKeyPairFromKmsPublicKey(
          edPrivate.toPublic().data.array,
          KmsRegion,
          solanaAliasName
        ),
        spec = KeyGenerator.toSignatureProvider(pair, "sol-batchopaaaa", {
          type: SignatureProviderType.KMS,
          awsKmsRegion: KmsRegion,
          awsKmsKeyId: solanaAliasName
        })
      expect(spec).toBe(
        `sol-batchopaaaa,solana,solana,${edPrivate.toPublic().toNativeString()},KMS:${KmsRegion}:${solanaAliasName}`
      )
      expect(pair).not.toHaveProperty("privateKey")
      expect(() => solanaSdkPrivateKey(pair)).toThrow(/custodied by AWS KMS/)
    })

    it("asserts a KMS source carries BOTH its region and its key id", () => {
      const pair = kmsPair()
      expect(() =>
        KeyGenerator.toSignatureProvider(pair, "eth-batchopaaaa", {
          type: SignatureProviderType.KMS,
          awsKmsKeyId: KmsAliasName
        })
      ).toThrow(/a KMS source requires awsKmsRegion \+ awsKmsKeyId/)
      expect(() =>
        KeyGenerator.toSignatureProvider(pair, "eth-batchopaaaa", {
          type: SignatureProviderType.KMS,
          awsKmsRegion: KmsRegion
        })
      ).toThrow(/a KMS source requires awsKmsRegion \+ awsKmsKeyId/)
    })
  })

  describe("a tooling-less context (a cluster-less key command has no wire-sysio build)", () => {
    it("context() with no build path names NO sys-util", () => {
      const built = KeyGenerator.context()
      expect(built).toEqual({})
      expect(built.sysUtil).toBeUndefined()
    })

    it("still generates K1 / ED / EM — those backends need no binary", async () => {
      const context = KeyGenerator.context()
      expect((await KeyGenerator.create(KeyType.K1, context)).type).toBe(KeyType.K1)
      expect((await KeyGenerator.create(KeyType.ED, context)).type).toBe(KeyType.ED)
      expect((await KeyGenerator.create(KeyType.EM, context)).address).toMatch(
        /^0x[0-9a-fA-F]{40}$/
      )
    })

    it("refuses a BLS generation, naming sys-util as the missing tooling", async () => {
      await expect(
        KeyGenerator.create(KeyType.BLS, KeyGenerator.context())
      ).rejects.toThrow(
        /BLS generation requires the sys-util binary — build the context from a wire-sysio build path/
      )
    })
  })
})

describe("keygen extra records", () => {
  let dir: string
  beforeAll(() => {
    dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "keygen-extra-"))
    Fs.mkdirSync(Path.join(dir, "bin"), { recursive: true })
    const sysUtil = Path.join(dir, KeyGenerator.SysUtilSubpath)
    Fs.writeFileSync(sysUtil, `#!/bin/sh\ncat <<'KEYEOF'\n${BLS_OUTPUT}\nKEYEOF\n`)
    Fs.chmodSync(sysUtil, 0o755)
  })
  afterAll(() => {
    Fs.rmSync(dir, { recursive: true, force: true })
  })

  it("create(ED) records the keygen IDENTITY — public half only, never the secret", async () => {
    const { StepExtraRecorder } = await import("@wireio/cluster-tool/report")
    const context = KeyGenerator.context(BinaryLessBuildPath)
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
        type: KeyType.ED,
        publicKey: pair.publicKey
      }
    ])
  })

  it("create(K1) records the sdk-core keygen — the backend that replaced clio", async () => {
    const { StepExtraRecorder } = await import("@wireio/cluster-tool/report")
    const recorder = new StepExtraRecorder()
    const pair = await StepExtraRecorder.runWith(recorder, () =>
      KeyGenerator.create(KeyType.K1, KeyGenerator.context(BinaryLessBuildPath), {
        purpose: "operator x — wire key"
      })
    )
    expect(recorder.calls).toEqual([
      {
        client: "sdk-core",
        kind: "keygen",
        keyType: "K1",
        purpose: "operator x — wire key",
        type: KeyType.K1,
        publicKey: pair.publicKey
      }
    ])
  })

  it("create(EM) records the ethers keygen with the address — no derivation path, since nothing is derived", async () => {
    const { StepExtraRecorder } = await import("@wireio/cluster-tool/report")
    const recorder = new StepExtraRecorder()
    const pair = await StepExtraRecorder.runWith(recorder, () =>
      KeyGenerator.create(KeyType.EM, KeyGenerator.context(BinaryLessBuildPath))
    )
    expect(recorder.calls).toEqual([
      {
        client: "ethers",
        kind: "keygen",
        keyType: "EM",
        purpose: null,
        type: KeyType.EM,
        publicKey: pair.publicKey,
        address: pair.address
      }
    ])
    expect(recorder.calls[0]).not.toHaveProperty("derivation")
  })

  it("create(BLS) records the exact sys-util command line and the proof of possession", async () => {
    const { StepExtraRecorder } = await import("@wireio/cluster-tool/report")
    const context = KeyGenerator.context(dir),
      recorder = new StepExtraRecorder()
    const pair = await StepExtraRecorder.runWith(recorder, () =>
      KeyGenerator.create(KeyType.BLS, context, { purpose: "node_00 — finalizer" })
    )
    expect(recorder.calls).toEqual([
      {
        client: "sys-util",
        kind: "keygen",
        command: [context.sysUtil, ...KeyGenerator.BLSCreateCommand],
        keyType: "BLS",
        purpose: "node_00 — finalizer",
        type: KeyType.BLS,
        publicKey: pair.publicKey,
        proofOfPossession: pair.proofOfPossession
      }
    ])
  })

  it.each([
    ["K1", KeyType.K1],
    ["ED", KeyType.ED],
    ["EM", KeyType.EM],
    ["BLS", KeyType.BLS]
  ])(
    "NEVER lands a private key in a keygen extra record (%s)",
    async (_curve, keyType) => {
      const { StepExtraRecorder } = await import("@wireio/cluster-tool/report")
      const { findKeyMaterial } = await import("@wireio/cluster-tool-shared")
      const recorder = new StepExtraRecorder()
      const pair = await StepExtraRecorder.runWith(recorder, () =>
        KeyGenerator.create(keyType, KeyGenerator.context(dir), {
          purpose: "leak guard"
        })
      )
      // The recorder's payload is what the Report renderers serialize verbatim
      // into cluster-build.{csv,md,html} — a real run's reports were VERIFIED to
      // carry 15 PVT_ keys before this was fixed. Assert against the ONE shared
      // pattern set so a new secret encoding is caught here too.
      const serialized = JSON.stringify(recorder.calls)
      expect(serialized).not.toContain(pair.privateKey)
      expect(findKeyMaterial(serialized)).toEqual([])
    }
  )
})
