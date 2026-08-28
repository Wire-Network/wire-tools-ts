import {
  BatchOperatorDisputeScenario,
  type BatchOperatorDisputeScenarioOptions
} from "@wireio/test-flow-batch-operator-slashing/BatchOperatorDisputeScenario"

const TerminalTieOptions = {
  name: "flow-batch-operator-terminal-tie",
  description:
    "A three-member schedule loses one operator; its two live deliverers tie, then the canonical candidate wins the dispute vote and the losing deliverer is slashed",
  deliveryOperators: ["dispop.a", "dispop.b"],
  candidateTags: ["canonical", "fork"],
  losingOperators: ["dispop.b"],
  terminatedOperator: "dispop.c"
} satisfies BatchOperatorDisputeScenarioOptions

/** Exercises the production terminal-tie guard with two live eligible candidates. */
export class TerminalTieScenario extends BatchOperatorDisputeScenario {
  constructor() {
    super(TerminalTieOptions)
  }
}
