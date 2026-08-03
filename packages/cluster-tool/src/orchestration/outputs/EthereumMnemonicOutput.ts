import { outputKey, type OutputKey } from "../OutputStore.js"

/**
 * Typed cross-step handle to the run's CLUSTER-SCOPED Ethereum HD mnemonic
 * PHRASE — the seed every operator's EM (secp256k1) outpost key is derived
 * from. Generated once by `KeySteps.runGenerateNodeKeys` under an SSM
 * signature provider and consumed by
 * `WireOperatorProvisioningTool.runIdentityMaterialization`.
 *
 * ABSENT under `KEY` / `KIOD`, where operator EM keys stay on the published
 * `EthereumOutpostBootstrapper.AnvilMnemonic` so every flow keeps deriving
 * byte-identical wallets.
 *
 * It lives HERE and NEVER on `ClusterConfig`: the resolved config is persisted
 * as `cluster-config.json` and copied into the archives `wire-cluster-tool
 * package` produces, so a mnemonic on it would make every operator's EM private
 * key re-derivable by anyone holding the deployable artifact — the same defect
 * as shipping the anvil mnemonic.
 */
export const EthereumMnemonicKey: OutputKey<string> = outputKey(
  "cluster.ethereumMnemonic",
  "the cluster-scoped Ethereum HD mnemonic phrase operator EM keys derive from"
)
