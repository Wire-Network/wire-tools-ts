import { execFile } from "node:child_process"
import { promisify } from "node:util"
import Path from "node:path"
import Assert from "node:assert"
import { ethers } from "ethers"
import { match } from "ts-pattern"
import { KeyType, PrivateKey } from "@wireio/sdk-core"
import {
  SignatureProviderType,
  type ClusterSignatureProviderConfig
} from "@wireio/cluster-tool-shared"
import { Constants } from "../../Constants.js"
import { getLogger } from "../../logging/Logger.js"
import { StepExtraRecorder } from "../../report/tools/StepExtraRecorder.js"
import {
  ethereumKeyPairFromWallet,
  ethereumSdkPrivateKey,
  ethereumUncompressedPublicKeyHex,
  solanaSdkPrivateKey
} from "../../utils/keyPairUtils.js"
import type {
  EthereumKeyPair,
  KeyPair,
  SolanaKeyPair,
  WireFinalizerKeyPair,
  WireKeyPair
} from "../../types/KeyPair.js"
import type { ClusterKeyStore } from "../../orchestration/outputs/ClusterKeyStore.js"

const log = getLogger("KeyGenerator")
const execFileAsync = promisify(execFile)

/** Extract a single regex capture from command output, or throw with the output. */
function parseField(stdout: string, pattern: RegExp, label: string): string {
  const value = stdout.match(pattern)?.[1] ?? null
  Assert.ok(value != null, `Failed to parse ${label} from output:\n${stdout}`)
  return value
}

/**
 * The single, generic key-generation facade for every curve the harness uses.
 * `create<T>(type, context, options)` dispatches by {@link KeyType} to the
 * heterogeneous backends — K1 via `clio`, BLS via `sys-util`, ED via sdk-core, EM
 * via an anvil HD wallet — and returns the precisely-typed {@link KeyPair}<T>.
 * There is NO per-curve PUBLIC entry point; callers name a type, the facade owns
 * the "how" (see `one-generic-facade-per-concept`). Folds the former
 * `WireKeyGenerator` (+ `cluster/keyGen.ts`); K1/BLS shell to `clio` / `sys-util`
 * and parse the WIF console output, preserving parity with the Python launcher.
 */
export namespace KeyGenerator {
  /** Timeout for a single key-generation subprocess (ms). */
  export const CommandTimeoutMs = 10_000
  /** Subpath (under the build dir) of the `sys-util` binary (BLS generation). */
  export const SysUtilSubpath = "bin/sys-util"
  /** BIP-44 Ethereum HD derivation path prefix (append the account index). */
  export const EthereumDerivationPath = "m/44'/60'/0'/0/"

  /** `clio` argv generating a K1 pair (shared by the backend + the extra record). */
  export const K1CreateCommand = ["create", "key", "--k1", "--to-console"] as const
  /** `sys-util` argv generating a BLS pair (shared by the backend + the extra record). */
  export const BLSCreateCommand = ["bls", "create", "key", "--to-console"] as const

  /** Regex captures for the `clio` / `sys-util` key-generation console output. */
  export namespace Pattern {
    export const K1Private = /Private key:\s+(PVT_K1_\S+)/
    export const K1Public = /Public key:\s+(PUB_K1_\S+)/
    export const BLSPrivate = /Private key:\s+(PVT_BLS_\S+)/
    export const BLSPublic = /Public key:\s+(PUB_BLS_\S+)/
    export const BLSProofOfPossession = /Proof of Possession:\s+(SIG_BLS_\S+)/
  }

  /** External tooling + material the per-curve backends need. */
  export interface Context {
    /** `clio` binary — K1 (secp256k1) generation. */
    readonly clio: string
    /** `sys-util` binary — BLS finalizer generation. */
    readonly sysUtil: string
    /** Anvil HD mnemonic — EM (secp256k1) deterministic derivation. */
    readonly ethereumMnemonic: ethers.Mnemonic
  }

  /** Per-call options. Only EM consults {@link CreateOptions.ethereumHdIndex}. */
  export interface CreateOptions {
    /** HD account index for EM derivation (deterministic anvil account). */
    readonly ethereumHdIndex?: number
    /** What the generated pair is FOR — lands in the step's `extra` record. */
    readonly purpose?: string
  }

  /**
   * Build a {@link Context} from a resolved cluster config's `clio` binary, build
   * path, and the anvil mnemonic phrase.
   *
   * @param clio - The `clio` binary path.
   * @param buildPath - The wire-sysio build dir (holds `bin/sys-util`).
   * @param ethereumMnemonicPhrase - The anvil HD mnemonic phrase.
   * @returns A ready {@link Context}.
   */
  export function context(
    clio: string,
    buildPath: string,
    ethereumMnemonicPhrase: string
  ): Context {
    return {
      clio,
      sysUtil: Path.join(buildPath, SysUtilSubpath),
      ethereumMnemonic: ethers.Mnemonic.fromPhrase(ethereumMnemonicPhrase)
    }
  }

  /**
   * Generate a {@link KeyPair} of curve `T` — the single entry point. Dispatches on
   * `type` to the matching backend and returns the precisely-typed pair.
   *
   * @param type - The curve to generate (`K1` / `BLS` / `ED` / `EM`).
   * @param context - Binaries + mnemonic the backends require.
   * @param options - Per-curve extras (EM's HD index).
   * @returns The generated `KeyPair<T>`.
   */
  export async function create<T extends KeyType>(
    type: T,
    context: Context,
    options: CreateOptions = {}
  ): Promise<KeyPair<T>> {
    const keyPair = (await createByType(type, context, options)) as unknown as KeyPair<T>
    recordKeygen(type, context, options, keyPair)
    return keyPair
  }

  /**
   * Land the generated pair in the running step's `extra`: the FULL key
   * material (dev-cluster keys — the cluster state persists them anyway),
   * what it is for, and HOW it was generated — the exact command line for
   * the `clio` / `sys-util` backends, the library + derivation otherwise.
   */
  function recordKeygen(
    type: KeyType,
    context: Context,
    options: CreateOptions,
    keyPair: KeyPair
  ): void {
    const mechanism = match<KeyType, StepExtraRecorder.ClientCall>(type)
      .with(KeyType.K1, () => ({
        client: "clio",
        kind: "keygen",
        command: [context.clio, ...K1CreateCommand]
      }))
      .with(KeyType.BLS, () => ({
        client: "sys-util",
        kind: "keygen",
        command: [context.sysUtil, ...BLSCreateCommand]
      }))
      .with(KeyType.ED, () => ({ client: "sdk-core", kind: "keygen" }))
      .with(KeyType.EM, () => ({
        client: "ethers",
        kind: "keygen",
        derivation: `${EthereumDerivationPath}${options.ethereumHdIndex}`
      }))
      .otherwise(() => ({ client: "sdk-core", kind: "keygen" }))
    StepExtraRecorder.record({
      ...mechanism,
      keyType: KeyType[type],
      purpose: options.purpose ?? null,
      keyPair
    })
  }

  /**
   * Non-generic dispatch — `match` on a concrete {@link KeyType} (not the generic
   * `T`, which control-flow would otherwise keep binding into the pattern). The one
   * `KeyPair<T>` cast lives at the {@link create} boundary above.
   */
  async function createByType(
    type: KeyType,
    context: Context,
    options: CreateOptions
  ): Promise<KeyPair> {
    return match(type)
      .with(KeyType.K1, () => createK1(context.clio))
      .with(KeyType.BLS, () => createBLS(context.sysUtil))
      .with(KeyType.ED, async () => createED())
      .with(KeyType.EM, async () =>
        createEM(context.ethereumMnemonic, options.ethereumHdIndex)
      )
      .otherwise(() => {
        throw new Error(`KeyGenerator: unsupported key type ${KeyType[type] ?? type}`)
      })
  }

  /** Generate a producer node's composite K1 + BLS key set, in parallel. */
  export async function createProducerKeySet(
    context: Context,
    purpose?: string
  ): Promise<ClusterKeyStore.ProducerKeySet> {
    log.debug("generating producer node key set")
    const [k1, bls] = await Promise.all([
      create(KeyType.K1, context, {
        purpose: purpose != null ? `${purpose} — block signing (K1)` : undefined
      }),
      create(KeyType.BLS, context, {
        purpose: purpose != null ? `${purpose} — finalizer (BLS)` : undefined
      })
    ])
    return { k1, bls }
  }

  // ── private per-curve backends ────────────────────────────────────────────

  /** K1 (secp256k1) via `clio create key --k1 --to-console`. */
  async function createK1(clioBinary: string): Promise<WireKeyPair> {
    const { stdout } = await execFileAsync(clioBinary, [...K1CreateCommand], {
      timeout: CommandTimeoutMs
    })
    return {
      type: KeyType.K1,
      privateKey: parseField(stdout, Pattern.K1Private, "K1 private key"),
      publicKey: parseField(stdout, Pattern.K1Public, "K1 public key")
    }
  }

  /** BLS finalizer via `sys-util bls create key --to-console`. */
  async function createBLS(sysUtilBinary: string): Promise<WireFinalizerKeyPair> {
    const { stdout } = await execFileAsync(sysUtilBinary, [...BLSCreateCommand], {
      timeout: CommandTimeoutMs
    })
    return {
      type: KeyType.BLS,
      privateKey: parseField(stdout, Pattern.BLSPrivate, "BLS private key"),
      publicKey: parseField(stdout, Pattern.BLSPublic, "BLS public key"),
      proofOfPossession: parseField(
        stdout,
        Pattern.BLSProofOfPossession,
        "BLS proof of possession"
      )
    }
  }

  /** ED (Ed25519) via sdk-core — no external process. */
  function createED(): SolanaKeyPair {
    const edPrivate = PrivateKey.generate(KeyType.ED)
    return {
      type: KeyType.ED,
      publicKey: edPrivate.toPublic().toString(),
      privateKey: edPrivate.toString()
    }
  }

  /** EM (secp256k1) via the anvil HD wallet at `ethereumHdIndex` (deterministic). */
  function createEM(mnemonic: ethers.Mnemonic, ethereumHdIndex?: number): EthereumKeyPair {
    Assert.ok(
      ethereumHdIndex != null,
      "KeyGenerator.create(EM): options.ethereumHdIndex is required"
    )
    const wallet = ethers.HDNodeWallet.fromMnemonic(
      mnemonic,
      `${EthereumDerivationPath}${ethereumHdIndex}`
    )
    return ethereumKeyPairFromWallet(wallet)
  }

  // ── signature-provider SOURCE (the spec's final segment) ──────────────────

  /**
   * Where a rendered `--signature-provider` spec sources its private key: `KEY`
   * (inline private key), `SSM` (region + rendered secret id), or `KIOD` (a kiod
   * wallet URL). Rendered as the spec's final segment by {@link toProviderSegment}.
   */
  export interface SignatureProviderSource {
    /** The provider type. */
    type: SignatureProviderType
    /** AWS region (SSM only). */
    awsRegion?: string
    /** Rendered SSM secret id for this key (SSM only). */
    awsSecretId?: string
    /** kiod wallet URL (KIOD only). */
    kiodUrl?: string
  }

  /** The default source — an inline `KEY:` spec (byte-identical to the historical output). */
  export const DefaultKeySource: SignatureProviderSource = {
    type: SignatureProviderType.KEY
  }

  /**
   * Build the {@link SignatureProviderSource} for a cluster's signature-provider
   * config: `KEY` → inline; `SSM` → region + the pre-rendered per-key
   * `secretId`; `KIOD` → the `kiodUrl`.
   *
   * @param providerConfig - The cluster signature-provider config.
   * @param secretId - The rendered SSM secret id for this key (SSM only).
   * @param kiodUrl - The kiod wallet URL (KIOD only).
   * @returns The rendering source.
   */
  export function keySource(
    providerConfig: ClusterSignatureProviderConfig,
    secretId: string,
    kiodUrl: string
  ): SignatureProviderSource {
    return match(providerConfig.type)
      .with(SignatureProviderType.KEY, () => DefaultKeySource)
      .with(SignatureProviderType.SSM, () => {
        Assert.ok(
          providerConfig.ssm != null,
          "KeyGenerator.keySource: an SSM provider requires ssm settings"
        )
        return {
          type: SignatureProviderType.SSM,
          awsRegion: providerConfig.ssm.awsRegion,
          awsSecretId: secretId
        }
      })
      .with(SignatureProviderType.KIOD, () => ({
        type: SignatureProviderType.KIOD,
        kiodUrl
      }))
      .exhaustive()
  }

  /**
   * Render the final `<provider>:<…>` segment of a signature-provider spec:
   * `KEY:<privateKey>` (inline — the default), `SSM:<region>:<secretId>`, or
   * `KIOD:<url>`. The C++ `signature_provider_manager_plugin` parses every form.
   */
  function toProviderSegment(
    source: SignatureProviderSource,
    keyMaterial: string
  ): string {
    return match(source.type)
      .with(SignatureProviderType.KEY, () => `KEY:${keyMaterial}`)
      .with(SignatureProviderType.SSM, () => {
        Assert.ok(
          source.awsRegion != null && source.awsSecretId != null,
          "KeyGenerator.toProviderSegment: an SSM source requires awsRegion + awsSecretId"
        )
        return `SSM:${source.awsRegion}:${source.awsSecretId}`
      })
      .with(SignatureProviderType.KIOD, () => {
        Assert.ok(
          source.kiodUrl != null,
          "KeyGenerator.toProviderSegment: a KIOD source requires kiodUrl"
        )
        return `KIOD:${source.kiodUrl}`
      })
      .exhaustive()
  }

  // ── nodeop signature-provider formatters + well-known dev keys ─────────────

  /**
   * The single generic nodeop `--signature-provider` formatter — every curve the
   * signature_provider_manager_plugin accepts, one entry point. Dispatches on the
   * pair's curve: `K1` block-signing / `BLS` finalizer (WIRE, name derived from
   * the public key) and `EM` ethereum / `ED` solana (outpost clients — these
   * REQUIRE a `providerName` like `eth-<account>` / `sol-<account>`, and encode
   * the key material in the chain-native format the plugin expects). One public
   * entry; per-curve backends stay private (see `one-generic-facade-per-concept`).
   *
   * @param pair - A signing key pair (`K1` / `BLS` / `EM` / `ED`).
   * @param providerName - Provider name — required for `EM` / `ED`, ignored otherwise.
   * @param source - Where the spec sources its key (default {@link DefaultKeySource} → inline `KEY:`).
   * @returns The `<name>,<chain>,<key-tag>,<pub>,<provider-segment>` provider spec.
   */
  export function toSignatureProvider(
    pair: KeyPair,
    providerName?: string,
    source: SignatureProviderSource = DefaultKeySource
  ): string {
    return match(pair.type)
      .with(KeyType.K1, () => toSignatureProviderK1(pair, source))
      .with(KeyType.BLS, () => toSignatureProviderBLS(pair, source))
      .with(KeyType.EM, () =>
        toSignatureProviderEM(
          pair as EthereumKeyPair,
          assertProviderName(pair, providerName),
          source
        )
      )
      .with(KeyType.ED, () =>
        toSignatureProviderED(
          pair as SolanaKeyPair,
          assertProviderName(pair, providerName),
          source
        )
      )
      .otherwise(() => {
        throw new Error(
          `KeyGenerator.toSignatureProvider: unsupported key type ${KeyType[pair.type] ?? pair.type}`
        )
      })
  }

  /** Assert the chain-client provider name is present for EM/ED specs. */
  function assertProviderName(pair: KeyPair, providerName?: string): string {
    Assert.ok(
      providerName != null && providerName.length > 0,
      `KeyGenerator.toSignatureProvider: providerName is required for ${KeyType[pair.type]} providers`
    )
    return providerName
  }

  /** K1 block-signing provider spec (private — dispatched by {@link toSignatureProvider}). */
  function toSignatureProviderK1(
    pair: KeyPair,
    source: SignatureProviderSource
  ): string {
    return `wire-${pair.publicKey},wire,wire,${pair.publicKey},${toProviderSegment(source, pair.privateKey)}`
  }

  /** BLS finalizer provider spec (private — dispatched by {@link toSignatureProvider}). */
  function toSignatureProviderBLS(
    pair: KeyPair,
    source: SignatureProviderSource
  ): string {
    return `wire-bls-${pair.publicKey},wire,wire_bls,${pair.publicKey},${toProviderSegment(source, pair.privateKey)}`
  }

  /**
   * EM (ethereum outpost) provider spec — 64-byte uncompressed public key
   * (`0x` + 128 hex, no `04` marker) + the provider-sourced key segment.
   */
  function toSignatureProviderEM(
    pair: EthereumKeyPair,
    providerName: string,
    source: SignatureProviderSource
  ): string {
    return [
      providerName,
      "ethereum",
      "ethereum",
      ethereumUncompressedPublicKeyHex(pair),
      toProviderSegment(source, ethereumSdkPrivateKey(pair).toNativeString())
    ].join(",")
  }

  /** ED (solana outpost) provider spec — base58 public key + the provider-sourced key segment. */
  function toSignatureProviderED(
    pair: SolanaKeyPair,
    providerName: string,
    source: SignatureProviderSource
  ): string {
    const privateKey = solanaSdkPrivateKey(pair)
    return [
      providerName,
      "solana",
      "solana",
      privateKey.toPublic().toNativeString(),
      toProviderSegment(source, privateKey.toNativeString())
    ].join(",")
  }

  /**
   * Dev-only, bootstrap-only bios K1 key (mirrors the Python launcher). NEVER
   * authoritative outside a test cluster — changing its source without updating the
   * launcher breaks cross-tool parity.
   */
  export const BiosK1Key: WireKeyPair = {
    type: KeyType.K1,
    publicKey: Constants.DefaultK1KeyPair.publicKeyWIF,
    privateKey: Constants.DefaultK1KeyPair.privateKeyWIF
  }

  /** Dev-only, bootstrap-only bios BLS finalizer key. Same parity caveat as {@link BiosK1Key}. */
  export const BiosBLSKey: WireFinalizerKeyPair = {
    type: KeyType.BLS,
    publicKey: Constants.DefaultBLSKeyPair.publicKeyStr,
    privateKey: Constants.DefaultBLSKeyPair.privateKeyStr,
    proofOfPossession: Constants.DefaultBLSKeyPair.proofOfPossessionStr
  }
}
