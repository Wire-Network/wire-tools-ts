import { outputKey, type OutputKey } from "../OutputStore.js"

/**
 * The outpost deploy artifacts an operator daemon (batch_operator_plugin /
 * underwriter_plugin nodeop) needs on its command line — prepared once per run
 * by `OperatorDaemonTool.planArtifactPreparation` (after both outpost deploys) and read
 * by every operator-node start step.
 */
export interface OperatorDaemonArtifacts {
  /** Generated `{contractName, address, abi}` files (one per OPP outpost contract). */
  readonly ethereumAbiFiles: string[]
  /** Deployed Ethereum outpost addresses (from `outpost-addrs.json`). */
  readonly ethereumAddresses: Record<string, string>
  /** The `opp-outpost` program id (base58). */
  readonly solanaProgramId: string
  /** Cluster-local copy of the `opp_outpost` IDL. */
  readonly solanaIdlFile: string
}

/** Typed cross-step handle to the prepared {@link OperatorDaemonArtifacts}. */
export const OperatorDaemonArtifactsKey: OutputKey<OperatorDaemonArtifacts> = outputKey(
  "cluster.operatorDaemonArtifacts",
  "outpost deploy artifacts for operator daemon command lines (ETH ABIs + addrs, SOL program id + IDL)"
)
