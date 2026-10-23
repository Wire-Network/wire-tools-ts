import {
  BatchOperatorDisputeConstants as Constants,
  BatchOperatorDisputeScenario
} from "@wireio/batch-operator-dispute-shared"

/** Two live operators contest a three-member schedule after one termination. */
export class BatchOperatorTerminalTieScenario extends BatchOperatorDisputeScenario {
  constructor() {
    super({
      name: "flow-batch-operator-terminal-tie",
      description:
        "A three-member schedule loses one operator; its two live deliverers tie, then the canonical candidate wins the dispute vote and the losing deliverer is slashed",
      deliveryOperators: [
        Constants.CanonicalOperator,
        Constants.LosingOperators[0]
      ],
      candidateTags: [Constants.EnvelopeTags[0], Constants.EnvelopeTags[1]],
      losingOperators: [Constants.LosingOperators[0]],
      terminatedOperator: Constants.DisputeOperators[2]
    })
  }
}
