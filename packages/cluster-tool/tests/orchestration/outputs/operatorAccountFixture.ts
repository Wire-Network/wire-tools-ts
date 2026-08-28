import { ethers } from "ethers"

import { Constants } from "@wireio/cluster-tool/Constants"
import {
  EthereumOutpostBootstrapper,
  type OperatorAccount
} from "@wireio/cluster-tool/orchestration"
import type { EthereumKeyPair, SolanaKeyPair } from "@wireio/cluster-tool/types"
import { ethereumKeyPairFromWallet } from "@wireio/cluster-tool/utils"
import { OperatorType } from "@wireio/opp-typescript-models"
import { KeyType, PrivateKey } from "@wireio/sdk-core"

/** Account index 1 of the anvil mnemonic (index 0 is the deploying signer). */
const AnvilHdIndex = 1

/** A REAL EM pair off the anvil mnemonic — decodable by `keyPairUtils`. */
function newEthereumKeyPair(): EthereumKeyPair {
  return ethereumKeyPairFromWallet(
    ethers.HDNodeWallet.fromMnemonic(
      ethers.Mnemonic.fromPhrase(EthereumOutpostBootstrapper.AnvilMnemonic),
      `${EthereumOutpostBootstrapper.DerivationPath}${AnvilHdIndex}`
    )
  )
}

/** A REAL ED pair — decodable by `solanaKeypair` / `solanaNativePublicKey`. */
function newSolanaKeyPair(): SolanaKeyPair {
  const privateKey = PrivateKey.generate(KeyType.ED)
  return {
    type: KeyType.ED,
    publicKey: privateKey.toPublic().toString(),
    privateKey: privateKey.toString()
  }
}

/**
 * An {@link OperatorAccount} carrying REAL Ethereum (EM) and Solana (ED) keys —
 * derived, never faked, so consumers that reconstruct a live signer from them
 * (`keyPairUtils`, `solanaNativePublicKey`) get a valid key. The `wire` (K1)
 * pair stays a readable placeholder because no test derives a signer from it.
 *
 * Both derivations are LAZY and memoized — the EM pair costs a BIP-39 PBKDF2
 * round and the ED pair an ed25519 keygen, and suites that exercise only the
 * harness-side identity (`ClusterKeyStore`) never read either field.
 *
 * Per-curve object literals — NOT a shared generic helper — so each field
 * resolves the `KeyPair<T>` conditional type on its own and the fixture needs
 * no `as OperatorAccount` cast.
 *
 * @param label - the harness-side handle; also seeds the placeholder K1 strings.
 * @param type - the proto {@link OperatorType} this identity is provisioned as.
 * @param account - the ON-CHAIN WIRE account name. Defaults to a
 *   node-owner-sponsored spelling that is deliberately DISTINCT from `label`,
 *   so a test that confuses the two still fails.
 * @return a fully-populated operator identity.
 */
export function fixtureOperatorAccount(
  label: string,
  type: OperatorType,
  account = `${Constants.BOOTSTRAP_NODE_OWNER}.${label}`
): OperatorAccount {
  let ethereum: EthereumKeyPair, solana: SolanaKeyPair
  return {
    label,
    publicationLabel: label,
    account,
    type,
    wire: { type: KeyType.K1, publicKey: `PUB_K1_${label}`, privateKey: `PVT_K1_${label}` },
    get ethereum(): EthereumKeyPair {
      return (ethereum ??= newEthereumKeyPair())
    },
    get solana(): SolanaKeyPair {
      return (solana ??= newSolanaKeyPair())
    }
  }
}
