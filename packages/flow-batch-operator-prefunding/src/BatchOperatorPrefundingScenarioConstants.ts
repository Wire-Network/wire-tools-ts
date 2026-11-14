import Assert from "node:assert"
import Path from "node:path"
import {
  BatchOperatorUnderwritingSteps,
  Constants as HarnessConstants,
  SyndicationScenario,
  WireLcoImportTool,
  type ClusterBuildOptions,
  type WireLcoExportTool
} from "@wireio/cluster-tool"

/**
 * Constants of the pre-funded launch flow. The committed exports under `resources/` are
 * TEMPLATES: each Ethereum staker row and each Solana balance row names a placeholder
 * identity, one per bootstrap batch operator, which the scenario's pre-bootstrap stage
 * (`BatchOperatorPrefundingScenarioExports`, through `WireLcoExportTool`) replaces with the
 * operator's pre-created, persisted outpost key before writing the exports the bootstrap
 * imports. Every operator staked 4 liqETH (earning 0.5 pretoken of yield) and syndicated
 * 4 liqSOL (buying 5 pretokens with 1 more); the pools seed from the custody left over.
 */
export namespace BatchOperatorPrefundingScenarioConstants {
  /** Epoch duration (s) — the shortest supported depot epoch. */
  export const EpochDurationSec = SyndicationScenario.EpochDurationSec
  /** Genesis producers. */
  export const ProducerCount = 3
  /** The bootstrap batch operators — exactly the identities the templates pre-fund. */
  export const BatchOperatorCount = 3
  /** No standalone underwriters: the batch operators run the underwriter role. */
  export const UnderwriterCount = 0
  /** The pre-created operators' durable handles, in index order. */
  export const OperatorLabels =
    HarnessConstants.batchOperatorLabels(BatchOperatorCount)

  /** The package's committed export templates. */
  export const ResourcesPath = Path.join(__dirname, "..", "resources")
  /** The frozen Ethereum outpost's export template: one staker per operator. */
  export const EthereumTemplateFile = Path.join(
    ResourcesPath,
    "ethereum-genesis-snapshot.json"
  )
  /** The Solana outpost's genesis export template: one balance per operator. */
  export const SolanaTemplateFile = Path.join(
    ResourcesPath,
    "solana-genesis-snapshot.json"
  )
  /** Both templates, by chain — what the export tool rewrites. */
  export const Templates: WireLcoExportTool.ChainFiles = {
    ethereum: EthereumTemplateFile,
    solana: SolanaTemplateFile
  }

  /**
   * The import's pricing, pool tuning and claim funding — the dev values the import would
   * otherwise take as placeholders, set explicitly so the plan names none.
   */
  export const LcoImport: ClusterBuildOptions["lcoImport"] = {
    ethereum: {
      nativePriceUsd: WireLcoImportTool.PlaceholderEthereumPriceUsd,
      pool: WireLcoImportTool.PlaceholderPoolTuning
    },
    solana: {
      nativePriceUsd: WireLcoImportTool.PlaceholderSolanaPriceUsd,
      pool: WireLcoImportTool.PlaceholderPoolTuning
    },
    dclaimFundingAccount: WireLcoImportTool.PlaceholderDclaimFundingAccount
  }

  /** One operator's placeholders: the template rows its persisted keys replace. */
  export interface OperatorTemplate {
    /** The operator's durable handle. */
    readonly label: string
    /** The Ethereum staker row's placeholder address (lowercase `0x`). */
    readonly ethereumTemplateAddress: string
    /** The Solana balance row's placeholder address (base58). */
    readonly solanaTemplateAddress: string
  }

  /** Every operator's placeholders, in label order. */
  export const OperatorTemplates: OperatorTemplate[] = [
    {
      label: OperatorLabels[0],
      ethereumTemplateAddress: "0xcc576c12e50c7fbf0c6b48049d7cb9dc65d70e00",
      solanaTemplateAddress: "8qhYnve1Li5E2LjQX5umXo5VDWFDUhUfkzpH3Wr8FKRp"
    },
    {
      label: OperatorLabels[1],
      ethereumTemplateAddress: "0x3d4e9bfb319097e51f4134abeeb3ed196f1b07f2",
      solanaTemplateAddress: "B5bAcw5MVqPgne2AkhRNkzguayJtj8Erbax5Ye3QPfPo"
    },
    {
      label: OperatorLabels[2],
      ethereumTemplateAddress: "0xa2071c5a4a7c739fd1cc0d47a0afcc5e9569d678",
      solanaTemplateAddress: "8v6jonosGd2fGq94sAaris1KM7yhJ1UJxTFgymfeewE3"
    }
  ]

  /**
   * The placeholders of `label`'s template rows.
   *
   * @param label - The operator's durable handle.
   * @returns Its placeholders.
   * @throws When the templates pre-fund no such operator.
   */
  export function templateOf(label: string): OperatorTemplate {
    const template = OperatorTemplates.find(candidate => candidate.label === label)
    Assert.ok(
      template != null,
      `flow-batch-operator-prefunding: the templates pre-fund no operator ${label}`
    )
    return template
  }

  /**
   * The user's syndication, in depot (LIQETH) subunits: two LIQETH — below each operator's
   * four LIQETH of imported credit and the role's ten LIQETH cap, so one operator can bond
   * it whole.
   */
  export const EthereumSyndicationAmount = 2_000_000_000n
  /** The syndication and the state its Steps record, under the `batchOperatorPrefunding.` output keys. */
  export const Plan = BatchOperatorUnderwritingSteps.createPlan(
    "batchOperatorPrefunding",
    { amount: EthereumSyndicationAmount, feeBps: 0 }
  )
  /** WIRE destination owned by the independent Ethereum syndicator. */
  export const EthereumUser = "prefund.user"
  /** Durable handle of the syndicator's persisted wallet — random, distinct from every operator. */
  export const EthereumWalletName = "batch-operator-prefunding-ethereum-user"
  /** The user whose syndication the pre-funded operators underwrite. */
  export const Syndicator: BatchOperatorUnderwritingSteps.EthereumSyndicator = {
    account: EthereumUser,
    walletName: EthereumWalletName,
    amount: Plan.amount
  }
  /** The outpost the syndication comes from. */
  export const Chain = HarnessConstants.ETHEREUM_CHAIN_CODENAME
  /** The shadow the operators bond. */
  export const Token = HarnessConstants.liqTokenCode(Chain)
}
