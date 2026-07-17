import { AccountSteps } from "./AccountSteps.js"
import { ClusterStateSteps } from "./ClusterStateSteps.js"
import { ConsensusSteps } from "./ConsensusSteps.js"
import { ContractSteps } from "./ContractSteps.js"
import { KeySteps } from "./KeySteps.js"
import { OperatorSteps } from "./OperatorSteps.js"
import { ProtocolSteps } from "./ProtocolSteps.js"
import { RegistrySteps } from "./RegistrySteps.js"
import { EthereumOutpostSteps } from "../ethereum/EthereumOutpostSteps.js"
import { SolanaOutpostSteps } from "../solana/SolanaOutpostSteps.js"
import { SysioContractSteps } from "./contracts/sysio/index.js"
import { ProcessSteps } from "./processes/index.js"

/**
 * The exported step palette — each member is a sub-namespace of
 * `ClusterBuildStep` factories the bootstrap + flows compose.
 *
 * Raw single-contract-action steps live under the generated-mirror tree
 * `Steps.contracts.sysio.<contract>.<action>`; the remaining members are
 * semantic composites (account/key/consensus provisioning, feature activation,
 * registry seeding, outpost deploys) that orchestrate several calls.
 */
export namespace Steps {
  /** Step-layer mirror of the `sysio.*` contracts: `Steps.contracts.sysio.<contract>.<action>`. */
  export namespace contracts {
    export import sysio = SysioContractSteps
  }

  /** Step-layer mirror of the managed processes: `Steps.processes.<process>.start`. */
  export import processes = ProcessSteps

  export import account = AccountSteps
  export import clusterState = ClusterStateSteps
  export import consensus = ConsensusSteps
  export import contract = ContractSteps
  export import ethereumOutpost = EthereumOutpostSteps
  export import keys = KeySteps
  export import operator = OperatorSteps
  export import protocol = ProtocolSteps
  export import registry = RegistrySteps
  export import solanaOutpost = SolanaOutpostSteps
}
