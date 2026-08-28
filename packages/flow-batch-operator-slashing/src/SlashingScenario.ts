import {
  BatchOperatorDisputeScenario,
  type BatchOperatorDisputeScenarioOptions
} from "./BatchOperatorDisputeScenario.js"
import { SlashingScenarioConstants as Constants } from "./SlashingScenarioConstants.js"

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
