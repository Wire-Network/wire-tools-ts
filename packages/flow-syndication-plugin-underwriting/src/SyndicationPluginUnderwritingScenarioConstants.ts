import {
  BatchOperatorUnderwritingSteps,
  outputKey
} from "@wireio/cluster-tool"

/** The syndications, pair rules and typed cross-step state of the plugin-underwriting flow. */
export namespace SyndicationPluginUnderwritingScenarioConstants {
  /** The flow's syndications and recorded state, under the `pluginUnderwriting.` output keys. */
  export const Plan =
    BatchOperatorUnderwritingSteps.createPlan("pluginUnderwriting")
  /** Pair-specific governance rules at the default challenge window, set in setup and restored at the end. */
  export const Config = BatchOperatorUnderwritingSteps.configOf(Plan)
  /** Independent Ethereum request state; all underwriting still belongs to the daemons. */
  export const EthereumPlan = BatchOperatorUnderwritingSteps.createPlan(
    "pluginUnderwritingEthereum",
    { amount: 2_000_000_000n, feeBps: 0 }
  )
  /**
   * Durable handle of the independent Ethereum syndicator's persisted wallet — a random
   * per-cluster wallet, distinct from every operator and bootstrap actor.
   */
  export const EthereumWalletName = "plugin-underwriting-ethereum-user"
  /** WIRE destination owned by the independent Ethereum syndicator. */
  export const EthereumUser = "synd.ethuser"
  /** The syndicated amount in native liqETH precision (`BatchOperatorUnderwritingSteps.ethereumNativeAmount`). */
  export const EthereumNativeAmount =
    BatchOperatorUnderwritingSteps.ethereumNativeAmount(EthereumPlan.amount)
  /** The ETH deposited for liqETH: extra headroom so a share price above one cannot leave the wallet short. */
  export const EthereumDepositAmount =
    BatchOperatorUnderwritingSteps.ethereumDepositWei(EthereumPlan.amount)
  /** One ether of gas headroom for the deposit, the approval and the syndication. */
  export const EthereumGasHeadroomWei =
    BatchOperatorUnderwritingSteps.EthereumGasHeadroomWei
  /**
   * The syndicator wallet's funded balance (one `anvil_setBalance`): the whole deposit plus
   * its gas headroom. Below the deposit, the deposit Step is the first failure.
   */
  export const EthereumWalletBalanceWei =
    BatchOperatorUnderwritingSteps.ethereumWalletBalanceWei(EthereumPlan.amount)
  /** Exact liquid shadow balances at the start of the Ethereum lifecycle. */
  export interface EthereumBalances {
    readonly holder: bigint
    readonly operators: bigint
  }
  /** Exact starting balances for the Ethereum lifecycle. */
  export const EthereumBefore = outputKey<EthereumBalances>(
    "pluginUnderwritingEthereum.before",
    "Ethereum balances before syndication"
  )
}
