import "source-map-support/register"

import { BatchOperatorTerminalTieScenario, FlowCLI } from "@wireio/cluster-tool"

/** Run the terminal two-candidate dispute flow — exit code = report success. */
async function main(): Promise<void> {
  const report = await FlowCLI.create(BatchOperatorTerminalTieScenario).run()
  process.exit(report.succeeded ? 0 : 1)
}

void main()
