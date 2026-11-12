import { NodeOwnerCommitSteps } from "./NodeOwnerCommitSteps.js"
import { NodeOwnerMintSteps } from "./NodeOwnerMintSteps.js"
import { NodeOwnerRegistrationSteps } from "./NodeOwnerRegistrationSteps.js"

/**
 * Step-layer node-owner registration: the `MockWireNodes` ERC-1155 mint, the
 * production `BAR.commitNode` claim that reaches the depot over OPP, and the
 * `sysio.roa` pair (`newnameduser` + `nodeownreg`) the depot inline-sends for
 * a claim — `Steps.nodeOwner.<surface>.<step>`.
 */
export namespace NodeOwnerSteps {
  export import commit = NodeOwnerCommitSteps
  export import mint = NodeOwnerMintSteps
  export import registration = NodeOwnerRegistrationSteps
}
