import { BatchOperatorDisputeScenario } from "./BatchOperatorDisputeScenario.js"

/** Two live operators contest a three-member schedule after one termination. */
export class BatchOperatorTerminalTieScenario extends BatchOperatorDisputeScenario {
  constructor() {
    super({
      name: "flow-batch-operator-terminal-tie",
      description:
        "A three-member schedule loses one operator; its two live deliverers tie, then the canonical candidate wins the dispute vote and the losing deliverer is slashed",
      deliveryOperators: ["dispop.a", "dispop.b"],
      candidateTags: ["canonical", "fork"],
      losingOperators: ["dispop.b"],
      terminatedOperator: "dispop.c"
    })
  }
}
