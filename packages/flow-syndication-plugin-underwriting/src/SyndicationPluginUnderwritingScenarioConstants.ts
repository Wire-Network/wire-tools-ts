import {
  BatchOperatorUnderwritingSteps,
  Constants as HarnessConstants,
  EthereumSyndicationTool,
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
  /** Independent prefunded Ethereum wallet, outside this flow's operator slots and the panic wallet. */
  export const EthereumHdIndex = 48
  /** WIRE destination owned by the independent Ethereum syndicator. */
  export const EthereumUser = "synd.ethuser"
  /** Convert depot shadow precision to the native liqETH precision. */
  export const EthereumNativeAmount =
    EthereumPlan.amount *
    10n **
      BigInt(
        EthereumSyndicationTool.LiqEthTokenPrecision -
          HarnessConstants.DepotPrecisionCap
      )
  /** Acquire extra liqETH so a share price above one cannot leave the syndicating wallet short. */
  export const EthereumDepositAmount = EthereumNativeAmount * 2n
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
