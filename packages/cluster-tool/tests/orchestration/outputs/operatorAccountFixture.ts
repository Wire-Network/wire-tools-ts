import { ethers } from "ethers"
import { KeyType, PrivateKey } from "@wireio/sdk-core"
import { OperatorType } from "@wireio/opp-typescript-models"
import { Constants } from "@wireio/cluster-tool/Constants"
import { NodeConfig, NodeRole } from "@wireio/cluster-tool/config"
import {
  EthereumOutpostBootstrapper,
  type ClusterBuildContext,
  type OperatorAccount
} from "@wireio/cluster-tool/orchestration"
import type { EthereumKeyPair, SolanaKeyPair } from "@wireio/cluster-tool/types"
import { ethereumKeyPairFromWallet } from "@wireio/cluster-tool/utils"

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

/**
 * Seed one producer {@link OperatorAccount} per hosted producer of every planned producer node,
 * mirroring what `WireOperatorProvisioningTool.runProducerMaterialization` accumulates.
 *
 * Every consumer that launches or renders a producing node
 * (`NodeopProcessSteps.resolveOperators` and, through it, `StartScriptSteps` and the
 * external-config rebind) reads these accounts rather than the node key set, because each
 * account owns its own BLS finalizer key — `regfinkey` enforces a global uniqueness check, so
 * siblings sharing their node's one key means only the first can ever register. The K1 is the
 * NODE's, identical across the accounts it hosts, exactly as the live path materializes it.
 *
 * @param ctx - the fixture context whose `keyStore` receives the accounts.
 * @returns the seeded accounts, in plan order.
 */
export function seedProducerOperators(
  ctx: ClusterBuildContext
): OperatorAccount[] {
  const seeded = NodeConfig.plan(ctx.config)
    .filter(node => node.role === NodeRole.producer)
    .flatMap(node =>
      node.producers.map(
        (label): OperatorAccount => ({
          label,
          publicationLabel: label,
          account: label,
          type: OperatorType.PRODUCER,
          wire: {
            type: KeyType.K1 as const,
            publicKey: `PUB_K1_n${node.index}`,
            privateKey: `PVT_K1_n${node.index}`
          },
          wireFinalizer: {
            type: KeyType.BLS as const,
            publicKey: `PUB_BLS_${label}`,
            privateKey: `PVT_BLS_${label}`,
            proofOfPossession: `SIG_BLS_${label}`
          }
        })
      )
    )
  seeded.forEach(operator => ctx.keyStore.setOperator(operator))
  return seeded
}
