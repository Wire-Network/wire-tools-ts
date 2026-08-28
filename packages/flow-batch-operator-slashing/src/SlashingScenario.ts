import {
  BatchOperatorDisputeScenario,
  SlashingScenarioConstants as Constants,
  type BatchOperatorDisputeScenarioOptions
} from "@wireio/cluster-tool"

const ThreeWaySlashingOptions = {
  name: "flow-batch-operator-slashing",
  description:
    "A three-candidate batch-operator split opens a dispute; Tier-1 owners vote the canonical checksum; both non-canonical deliverers are slashed",
  deliveryOperators: Constants.DisputeOperators,
  candidateTags: Constants.EnvelopeTags,
  losingOperators: Constants.LosingOperators
} satisfies BatchOperatorDisputeScenarioOptions

/** The original three-delivery dispute flow, retained as the multi-operator slash regression. */
export class SlashingScenario extends BatchOperatorDisputeScenario {
  constructor() {
    super(ThreeWaySlashingOptions)
  }
}
