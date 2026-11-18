import { NodeOwnerCommitSteps } from "./NodeOwnerCommitSteps.js"
import { NodeOwnerMintSteps } from "./NodeOwnerMintSteps.js"
import { NodeOwnerRegistrationSteps } from "./NodeOwnerRegistrationSteps.js"

/**
 * Step-layer node-owner registration: the `MockWireNodes` ERC-1155 mint, the
 * production `BAR.commitNode` claim that reaches the depot over OPP, the
 * `sysio.roa::nodeownreg` the depot inline-sends for a claim (it creates and
 * registers a new account), and the pre-existing-account fixtures that claim
 * rejects — `Steps.nodeOwner.<surface>.<step>`.
 */
export namespace NodeOwnerSteps {
  export import commit = NodeOwnerCommitSteps
  export import mint = NodeOwnerMintSteps
  export import registration = NodeOwnerRegistrationSteps
}
