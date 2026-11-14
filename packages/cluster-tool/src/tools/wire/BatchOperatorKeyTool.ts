import Assert from "node:assert"
import { match } from "ts-pattern"
import { KeyType } from "@wireio/sdk-core"
import { OperatorType } from "@wireio/opp-typescript-models"
import {
  SignatureProviderKeyPolicy,
  SignatureProviderType,
  type KeyCustodySettings
} from "@wireio/cluster-tool-shared"
import { Constants } from "../../Constants.js"
import { EthereumWallet } from "../../clients/ethereum/EthereumWallet.js"
import { KeyGenerator } from "../../clients/wire/KeyGenerator.js"
import { WireWallet } from "../../clients/wire/WireWallet.js"
import { ClusterConfigProvider } from "../../config/ClusterConfigProvider.js"
import { getLogger } from "../../logging/Logger.js"
import type { OperatorAccount } from "../../orchestration/outputs/OperatorAccount.js"
import { KeySteps } from "../../orchestration/steps/KeySteps.js"
import { eachSeries, mapSeries } from "../../utils/asyncUtils.js"
import { solanaKeyPairFromKeypair } from "../../utils/keyPairUtils.js"
import { EthereumFundingTool } from "../ethereum/EthereumFundingTool.js"
import { SolanaFundingTool } from "../solana/SolanaFundingTool.js"

const log = getLogger(__filename)

/**
 * Pre-creation of the bootstrap batch operators' signing keys in a cluster's
 * AWS custody store — the keys a launch pre-funds on the outposts BEFORE the
 * cluster exists, so the operators can underwrite from the first epoch.
 *
 * For every batch-operator label the tool obtains its wire K1, solana ED and
 * ethereum EM keys through the SAME adopt-or-create seam the bootstrap uses
 * (`KeySteps.adoptOrCreateSignatureProviderKey`: an existing SSM parameter or
 * KMS key — the K1 / EM / ED curves a `kms` block names; these ARE the batch
 * operators' account keys, so a K1 in the roster lands in KMS here — is
 * adopted, never replaced) and publishes every SSM-custodied curve
 * through the SAME publish primitive (`KeySteps.publishSignatureProviderKey`),
 * so a later `create` with `batchOperatorKeyPolicy: adoptOnly` finds exactly
 * these keys under exactly these ids. A KMS key it creates is a multi-Region
 * primary (`KMSClientProvider.createKey`), replicable later without changing
 * its public key; a single-Region key it adopts never can be, which the adopt
 * path warns about. What it reports is PUBLIC only: the
 * public keys, the EM addresses and the custody references the outposts are
 * funded against — never material (KMS has none to give; SSM's is never read
 * back).
 *
 * This is a cluster-less surface (there is no `ClusterBuildContext`, so no
 * Step and no Report — the `create-api-node` departure); the writes it performs
 * are the custody store's, through the primitives the bootstrap's Steps share.
 *
 * Under KEY custody there is no AWS store: the same pre-creation PERSISTS each
 * operator's three curves under its label handle in the cluster data directory
 * ({@link createPersisted} / {@link loadPersisted} — `WireWallet` for the K1,
 * `EthereumFundingTool.createWallet` for the EM, `SolanaFundingTool.createKeypair`
 * for the ED), and a scenario seeds them into its context's key store, which
 * `WireOperatorProvisioningTool.runIdentityMaterialization` adopts whole.
 */
export namespace BatchOperatorKeyTool {
  /** One pre-created key's PUBLIC listing row — never material. */
  export interface KeyListing {
    /** The batch operator's durable handle (`batchop.a`). */
    readonly label: string
    /** The key's curve (`K1` / `EM` / `ED`). */
    readonly keyType: KeyType
    /** The Wire-canonical public key (`PUB_<curve>_…`). */
    readonly publicKey: string
    /** The EM key's `0x` address — what the Ethereum outpost is funded against; absent for other curves. */
    readonly address?: string
    /** Where the secret lives: `SSM:<secretId>` or `KMS:<region>:<alias>`. */
    readonly custody: string
  }

  /** The curves a batch operator's identity materializes, in listing order. */
  export const KeyTypes = KeySteps.operatorKeyTypes(OperatorType.BATCH)

  /**
   * Adopt-or-create every curve of every batch operator in `labels`, publish
   * the SSM-custodied ones, and return the identities. Refuses a KEY / KIOD
   * provider (nothing to create into) and a label that is not a bootstrap
   * batch operator's. The cluster's `batchOperatorKeyPolicy` is deliberately
   * NOT consulted: that policy governs the BOOTSTRAP's create arm, and this
   * command IS the pre-creation an `adoptOnly` bootstrap relies on.
   *
   * @param settings - The resolved key-custody settings (SSM, optionally with KMS).
   * @param labels - The batch operators' durable handles (`Constants.batchOperatorLabels`).
   * @param keyContext - The key-generation tooling (none is needed for these curves).
   * @returns The identities, in `labels` order — public halves plus custody references.
   */
  export async function adoptOrCreate(
    settings: KeyCustodySettings,
    labels: readonly string[],
    keyContext: KeyGenerator.Context
  ): Promise<OperatorAccount[]> {
    Assert.ok(
      settings.signatureProvider.type === SignatureProviderType.SSM,
      `BatchOperatorKeyTool: pre-creating keys requires an SSM signature provider (got ${settings.signatureProvider.type}) — a KEY / KIOD cluster has no custody store to create them in`
    )
    labels.forEach(label =>
      Assert.ok(
        Constants.isBatchOperatorLabel(label),
        `BatchOperatorKeyTool: "${label}" is not a bootstrap batch-operator label (${Constants.BatchOperatorLabelPrefix}<letter>)`
      )
    )
    const creating: KeyCustodySettings = {
      ...settings,
      signatureProvider: {
        ...settings.signatureProvider,
        batchOperatorKeyPolicy: SignatureProviderKeyPolicy.adoptOrCreate
      }
    }
    return mapSeries(labels, async label => {
      const operator = await adoptOrCreateIdentity(creating, label, keyContext)
      await publish(creating, operator)
      log.info(
        `[batch-operator-keys] ${label} — WIRE ${operator.wire.publicKey}, ETH ${operator.ethereum.address}, SOL ${operator.solana.publicKey}`
      )
      return operator
    })
  }

  // ── KEY custody: persisted handles in the cluster data directory ──────────

  /**
   * Get-or-create every curve of every batch operator in `labels` under its
   * label handle in `dataPath` — the KEY-custody twin of {@link adoptOrCreate}:
   * a handle already holding a key is read back verbatim, so a re-run keeps the
   * identity the outposts were funded against and the launch-data exports name.
   * Refuses a label that is not a bootstrap batch operator's. Every generated
   * pair is random (`KeyGenerator`); nothing derives from a mnemonic or an index.
   *
   * @param dataPath - The cluster data directory (`ClusterConfigProvider.dataPath`).
   * @param labels - The batch operators' durable handles (`Constants.batchOperatorLabels`).
   * @param keyContext - The key-generation tooling (none is needed for these curves).
   * @returns The identities, in `labels` order — every curve's material included.
   */
  export async function createPersisted(
    dataPath: string,
    labels: readonly string[],
    keyContext: KeyGenerator.Context
  ): Promise<OperatorAccount[]> {
    assertBatchOperatorLabels(labels)
    return mapSeries(labels, async label => {
      await WireWallet.createKey(
        dataPath,
        label,
        keyContext,
        `batch operator ${label} — WIRE account key (K1)`
      )
      await EthereumFundingTool.createWallet(
        dataPath,
        label,
        keyContext,
        `batch operator ${label} — ethereum outpost key (EM)`
      )
      SolanaFundingTool.createKeypair(dataPath, label)
      const operator = persistedIdentity(dataPath, label)
      log.info(
        `[batch-operator-keys] ${label} — persisted: WIRE ${operator.wire.publicKey}, ETH ${operator.ethereum.address}, SOL ${operator.solana.publicKey}`
      )
      return operator
    })
  }

  /**
   * Read back the identities {@link createPersisted} persisted under `labels`
   * — what a scenario seeds into its context's key store, and what a verify Step
   * compares the bootstrap's adopted identities against.
   *
   * @param dataPath - The cluster data directory.
   * @param labels - The batch operators' durable handles.
   * @returns The identities, in `labels` order.
   * @throws When any curve of a label was never persisted.
   */
  export function loadPersisted(
    dataPath: string,
    labels: readonly string[]
  ): OperatorAccount[] {
    assertBatchOperatorLabels(labels)
    return labels.map(label => persistedIdentity(dataPath, label))
  }

  /** Refuse a label that is not a bootstrap batch operator's. */
  function assertBatchOperatorLabels(labels: readonly string[]): void {
    labels.forEach(label =>
      Assert.ok(
        Constants.isBatchOperatorLabel(label),
        `BatchOperatorKeyTool: "${label}" is not a bootstrap batch-operator label (${Constants.BatchOperatorLabelPrefix}<letter>)`
      )
    )
  }

  /** One batch operator's identity, every curve read back from its persisted handle. */
  function persistedIdentity(dataPath: string, label: string): OperatorAccount {
    return {
      label,
      // A batch operator owns its keys, and `sysio` creates its account under the handle.
      publicationLabel: label,
      account: label,
      type: OperatorType.BATCH,
      wire: WireWallet.loadKeyPair(dataPath, label),
      ethereum: EthereumWallet.loadKeyPair(dataPath, label),
      solana: solanaKeyPairFromKeypair(
        SolanaFundingTool.loadKeypair(dataPath, label)
      )
    }
  }

  /** The three curves of one batch operator, each adopted or created through the bootstrap's seam. */
  async function adoptOrCreateIdentity(
    settings: KeyCustodySettings,
    label: string,
    keyContext: KeyGenerator.Context
  ): Promise<OperatorAccount> {
    const [wire, solana, ethereum] = await Promise.all([
      KeySteps.adoptOrCreateSignatureProviderKey(
        settings,
        KeyType.K1,
        label,
        keyContext,
        { purpose: `batch operator ${label} — WIRE account key (K1)` }
      ),
      KeySteps.adoptOrCreateSignatureProviderKey(
        settings,
        KeyType.ED,
        label,
        keyContext,
        { purpose: `batch operator ${label} — solana outpost key (ED)` }
      ),
      KeySteps.adoptOrCreateSignatureProviderKey(
        settings,
        KeyType.EM,
        label,
        keyContext,
        { purpose: `batch operator ${label} — ethereum outpost key (EM)` }
      )
    ])
    return {
      label,
      // A batch operator owns its keys — published under its own handle, and
      // `sysio` creates its account under the handle itself.
      publicationLabel: label,
      account: label,
      type: OperatorType.BATCH,
      wire,
      ethereum,
      solana
    }
  }

  /**
   * Publish every SSM-custodied curve of `operator` to every replication region
   * — the rows `KeySteps.operatorKeyPublications` renders (KMS-custodied curves
   * are excluded there: they have no material to put).
   */
  async function publish(
    settings: KeyCustodySettings,
    operator: OperatorAccount
  ): Promise<void> {
    await eachSeries(
      KeySteps.operatorKeyPublications(settings, operator.label, operator.type),
      publication =>
        KeySteps.publishSignatureProviderKey(
          publication,
          KeySteps.identityPrivateKey(
            operator,
            publication.keyType,
            operator.label
          )
        )
    )
  }

  /**
   * The PUBLIC listing of pre-created keys — one row per operator per curve,
   * carrying the public key, the EM address and the custody reference. The
   * document a launch hands to whoever pre-funds the outposts; it contains no
   * secret and may be printed or committed.
   *
   * @param settings - The key-custody settings the ids render from.
   * @param operators - The identities {@link adoptOrCreate} returned.
   * @returns The listing rows, in operator then curve order.
   */
  export function toListing(
    settings: KeyCustodySettings,
    operators: readonly OperatorAccount[]
  ): KeyListing[] {
    return operators.flatMap(operator =>
      KeyTypes.map(keyType => {
        const keyPair = identityKeyPair(operator, keyType)
        return {
          label: operator.label,
          keyType,
          publicKey: keyPair.publicKey,
          ...(keyType === KeyType.EM ? { address: operator.ethereum.address } : {}),
          custody: KeySteps.custodyReference(
            ClusterConfigProvider.custodySource(
              settings,
              operator.publicationLabel,
              keyType
            )
          )
        }
      })
    )
  }

  /** The operator's key pair for `keyType` (wire K1 / ethereum EM / solana ED). */
  function identityKeyPair(
    operator: OperatorAccount,
    keyType: KeyType
  ): OperatorAccount["wire"] | OperatorAccount["ethereum"] | OperatorAccount["solana"] {
    const keyPair = match(keyType)
      .with(KeyType.K1, () => operator.wire)
      .with(KeyType.EM, () => operator.ethereum)
      .with(KeyType.ED, () => operator.solana)
      .otherwise(() => null)
    Assert.ok(
      keyPair != null,
      `BatchOperatorKeyTool: ${operator.label} has no ${KeyType[keyType]} key`
    )
    return keyPair
  }
}
