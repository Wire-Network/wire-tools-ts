import {
  BatchOperatorKeyTool,
  KeyGenerator,
  WireLcoExportTool,
  solanaNativePublicKey,
  type ClusterBuildOptions,
  type OperatorAccount
} from "@wireio/cluster-tool"
import { ChainKind } from "@wireio/opp-typescript-models"
import { BatchOperatorPrefundingScenarioConstants as Constants } from "./BatchOperatorPrefundingScenarioConstants.js"

/**
 * The flow's PRE-BOOTSTRAP stage (`FlowScenario.prepare`): what a real launch does before
 * `wire-cluster-tool create` — pre-create the bootstrap batch operators' identities
 * (`create-batch-operator-keys`; here under KEY custody, each curve persisted by the
 * operator's handle in the cluster data directory) and freeze the outposts' launch-data
 * exports with the operators' positions keyed by those outpost keys. Nothing here contacts
 * a chain: it runs before the cluster is composed. The scenario's context then seeds the
 * persisted identities into its key store for the bootstrap to adopt.
 */
export namespace BatchOperatorPrefundingScenarioExports {
  /**
   * Get-or-create every operator's WIRE, Ethereum and Solana keys under its handle — a
   * re-run keeps the identities the exports name.
   *
   * @param dataPath - The cluster data directory.
   * @param buildPath - The wire-sysio build dir the key-generation tooling resolves from.
   * @returns The operators' identities, in label order.
   */
  export async function createOperatorIdentities(
    dataPath: string,
    buildPath: ClusterBuildOptions["buildPath"]
  ): Promise<OperatorAccount[]> {
    return BatchOperatorKeyTool.createPersisted(
      dataPath,
      Constants.OperatorLabels,
      KeyGenerator.context(buildPath)
    )
  }

  /**
   * Every operator as the two placeholder → identity substitutions the export tool
   * applies: its Ethereum staker row takes the operator's EM key and address, its Solana
   * balance row the operator's ED key.
   *
   * @param operators - The pre-created identities.
   * @returns Two substitutions per operator.
   */
  export function templateHolders(
    operators: readonly OperatorAccount[]
  ): WireLcoExportTool.TemplateHolder[] {
    return operators.flatMap(
      (operator): WireLcoExportTool.TemplateHolder[] => {
        const template = Constants.templateOf(operator.label)
        return [
          {
            chain: ChainKind.EVM,
            templateAddress: template.ethereumTemplateAddress,
            identity: WireLcoExportTool.ethereumIdentity(operator.ethereum)
          },
          {
            chain: ChainKind.SVM,
            templateAddress: template.solanaTemplateAddress,
            identity: WireLcoExportTool.solanaIdentity(
              solanaNativePublicKey(operator.solana)
            )
          }
        ]
      }
    )
  }

  /**
   * Write both exports under the cluster data directory from the committed templates, each
   * row naming its operator's pre-created outpost key, and return their paths.
   *
   * @param dataPath - The cluster data directory.
   * @param operators - The pre-created identities.
   * @returns The written exports.
   */
  export function writeExports(
    dataPath: string,
    operators: readonly OperatorAccount[]
  ): WireLcoExportTool.ChainFiles {
    return WireLcoExportTool.writeExports(
      dataPath,
      Constants.Templates,
      templateHolders(operators)
    )
  }
}
