import { BatchOperatorDisputeConstants as Constants } from "./batchOperatorDisputeConstants.js"
import { BatchOperatorDisputeScenario } from "./BatchOperatorDisputeScenario.js"

/** Three distinct candidates open a dispute and slash both non-canonical deliverers. */
export class BatchOperatorSlashingScenario extends BatchOperatorDisputeScenario {
  constructor() {
    super({
      name: "flow-batch-operator-slashing",
      description:
        "A three-candidate batch-operator split opens a dispute; Tier-1 owners vote the canonical checksum; both non-canonical deliverers are slashed",
      deliveryOperators: Constants.DisputeOperators,
      candidateTags: Constants.EnvelopeTags,
      losingOperators: Constants.LosingOperators
    })
  }
}
