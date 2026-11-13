import { outputKey, type OutputKey } from "../OutputStore.js"

/**
 * The outpost deploy artifacts a batch-operator daemon, including its optional
 * underwriting role, needs on its command line — prepared once per run
 * by `OperatorDaemonTool.planArtifactPreparation` (after both outpost deploys) and read
 * by every operator-node start step.
 */
export interface OperatorDaemonArtifacts {
  /** Generated `{contractName, address, abi}` files (one per OPP outpost contract). */
  readonly ethereumAbiFiles: string[]
  /** Deployed Ethereum outpost addresses (from `outpost-addrs.json`). */
  readonly ethereumAddresses: Record<string, string>
  /** Generated unified Ethereum client JSON shared by operator daemon processes. */
  readonly ethereumClientConfigurationFile: string
  /** The OPP outpost program id (base58) — `liqsol_core`'s `declare_id`. */
  readonly solanaProgramId: string
  /** Cluster-local verbatim copy of the `liqsol_core` (OPP outpost) IDL. */
  readonly solanaIdlFile: string
}

/** Typed cross-step handle to the prepared {@link OperatorDaemonArtifacts}. */
export const OperatorDaemonArtifactsKey: OutputKey<OperatorDaemonArtifacts> = outputKey(
  "cluster.operatorDaemonArtifacts",
  "outpost artifacts for operator daemon command lines (ETH ABIs + client config, SOL program id + IDL)"
)
