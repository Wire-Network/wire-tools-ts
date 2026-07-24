import Assert from "node:assert"
import { ethers } from "ethers"
import { match } from "ts-pattern"
import { getLogger } from "@wireio/shared"
import { KeyType, PrivateKey } from "@wireio/sdk-core"
import {
  SignatureProviderType,
  type SignatureProviderConfig,
  type SignatureProviderConfigOf,
  type SignatureProviderKEYConfig,
  type SignatureProviderKIODConfig,
  type SignatureProviderSSMConfig
} from "@wireio/cluster-tool-shared"
import type {
  EthereumKeyPair,
  KeyPair,
  WireFinalizerKeyPair
} from "../types/KeyPair.js"
import { SSMClientProvider } from "./SSMClientProvider.js"

const log = getLogger(__filename)

/**
 * The behavior half of {@link SignatureProviderConfig} — resolves a provider
 * config into a hydrated signing key (for `KEY` / `SSM`) or a material-less
 * marker (for `KIOD`). ONE generic facade ({@link SignatureProviderConfigProvider.resolve})
 * dispatches by {@link SignatureProviderType} to the private per-provider
 * backends, mirroring `provider_spec_result` from the C++
 * `signature_provider_manager_plugin`: raw-material consumers accept `KEY` /
 * `SSM` resolutions only, and the resolution TYPE omits `keyPair` for `KIOD`, so
 * consuming a `KIOD` resolution where key material is required fails at the type
 * boundary.
 */
export namespace SignatureProviderConfigProvider {
  /** The hydrated signing key a `KEY` / `SSM` resolution carries. */
  export interface SignatureProviderResolutionKeyPair<K extends KeyType> {
    /** The assembled + verified key pair (pinned public key checked against the private key). */
    keyPair: KeyPair<K>
  }

  /**
   * A resolved signature provider: the provider config PLUS a hydrated
   * {@link KeyPair} for the material-bearing providers (`KEY` / `SSM`). `KIOD`
   * resolutions carry no key pair — the private key lives in the kiod wallet the
   * consumer binds to.
   */
  export type SignatureProviderResolution<
    T extends SignatureProviderType = SignatureProviderType,
    K extends KeyType = KeyType
  > = SignatureProviderConfigOf<T> &
    (T extends SignatureProviderType.KEY | SignatureProviderType.SSM
      ? SignatureProviderResolutionKeyPair<K>
      : unknown)

  /**
   * Resolve `config` into a {@link SignatureProviderResolution} — the single
   * generic entry point. Dispatches by `providerType` to the private backends;
   * the ONE cast (TS cannot correlate the runtime `match` arm with the generic
   * parameters) lives here.
   *
   * @param config - The provider config to resolve.
   * @returns The resolved provider (with a hydrated `keyPair` for `KEY` / `SSM`).
   */
  export async function resolve<
    T extends SignatureProviderType,
    K extends KeyType
  >(config: SignatureProviderConfig): Promise<SignatureProviderResolution<T, K>> {
    const resolution = await match(config)
      .with({ providerType: SignatureProviderType.KEY }, cfg => resolveKEY(cfg))
      .with({ providerType: SignatureProviderType.SSM }, cfg => resolveSSM(cfg))
      .with({ providerType: SignatureProviderType.KIOD }, cfg =>
        resolveKIOD(cfg)
      )
      .exhaustive()
    return resolution as unknown as SignatureProviderResolution<T, K>
  }

  /** `KEY` — the private key is inline; assemble + verify against the pinned public key. */
  async function resolveKEY(
    config: SignatureProviderKEYConfig
  ): Promise<
    SignatureProviderKEYConfig & SignatureProviderResolutionKeyPair<KeyType>
  > {
    return {
      ...config,
      keyPair: assembleAndVerify(
        config.type,
        config.publicKey,
        config.privateKey,
        config.proofOfPossession ?? null
      )
    }
  }

  /**
   * `SSM` — fetch the private key from AWS SSM once (`GetParameter` +
   * `WithDecryption`), then assemble + verify exactly like `KEY` (full `KEY:`
   * parity). The secret VALUE is never logged or echoed.
   */
  async function resolveSSM(
    config: SignatureProviderSSMConfig
  ): Promise<
    SignatureProviderSSMConfig & SignatureProviderResolutionKeyPair<KeyType>
  > {
    const privateKey = await fetchSSMPrivateKey(
      config.awsRegion,
      config.awsSecretId
    )
    return {
      ...config,
      keyPair: assembleAndVerify(
        config.type,
        config.publicKey,
        privateKey,
        config.proofOfPossession ?? null
      )
    }
  }

  /**
   * `KIOD` — material-less: the private key lives in the kiod wallet the
   * consumer binds to, so there is nothing to hydrate. Raw-material consumers
   * must NOT accept this resolution — the resolution type omits `keyPair`.
   */
  async function resolveKIOD(
    config: SignatureProviderKIODConfig
  ): Promise<SignatureProviderKIODConfig> {
    return config
  }

  /**
   * Fetch a private key from AWS SSM via {@link SSMClientProvider} — require a
   * `SecureString`, trim, reject empty. NEVER echoes the value (logs only the
   * parameter id + region + failure reason).
   */
  async function fetchSSMPrivateKey(
    region: string,
    secretId: string
  ): Promise<string> {
    try {
      return await SSMClientProvider.getParameter(region, secretId)
    } catch (error) {
      // NEVER echo the secret value — surface only the parameter id + reason.
      log.error(
        `SignatureProviderConfigProvider: failed to fetch SSM parameter ${secretId} in ${region}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
      throw error
    }
  }

  /** Assemble the curve-shaped {@link KeyPair} then verify its pinned public key. */
  function assembleAndVerify(
    type: KeyType,
    publicKey: string,
    privateKey: string,
    proofOfPossession: string | null
  ): KeyPair {
    const keyPair = assembleKeyPair(type, publicKey, privateKey, proofOfPossession)
    assertPublicKey(keyPair)
    return keyPair
  }

  /** Build the curve-shaped {@link KeyPair} (EM derives its address; BLS carries the PoP). */
  function assembleKeyPair(
    type: KeyType,
    publicKey: string,
    privateKey: string,
    proofOfPossession: string | null
  ): KeyPair {
    return match(type)
      .with(KeyType.BLS, () => {
        Assert.ok(
          proofOfPossession != null,
          "SignatureProviderConfigProvider: a BLS provider requires proofOfPossession"
        )
        return {
          type: KeyType.BLS,
          publicKey,
          privateKey,
          proofOfPossession
        } as WireFinalizerKeyPair
      })
      .with(
        KeyType.EM,
        () =>
          ({
            type: KeyType.EM,
            publicKey,
            privateKey,
            address: deriveEthereumAddress(privateKey)
          }) as EthereumKeyPair
      )
      .otherwise(() => ({ type, publicKey, privateKey }) as KeyPair)
  }

  /**
   * Verify the pinned `publicKey` matches the key derived from `privateKey`
   * (K1 / ED / EM). BLS is exempt — there is no TS-side BLS public-key
   * derivation; its authority is the config-carried proof of possession.
   */
  function assertPublicKey(keyPair: KeyPair): void {
    if (keyPair.type === KeyType.BLS) return
    const derived = PrivateKey.from(keyPair.privateKey).toPublic().toString()
    Assert.ok(
      derived === keyPair.publicKey,
      `SignatureProviderConfigProvider: pinned public key does not match the key derived from the private key (${KeyType[keyPair.type]})`
    )
  }

  /** The `0x` ethereum address derived from an EM (secp256k1) private key via ethers. */
  function deriveEthereumAddress(privateKey: string): string {
    return new ethers.Wallet(
      ethers.hexlify(PrivateKey.from(privateKey).data.array)
    ).address
  }
}
