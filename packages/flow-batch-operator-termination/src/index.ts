import { FlowCLI } from "@wireio/cluster-tool"
import { TerminationScenario } from "./TerminationScenario.js"

/** Run the batch-operator-termination flow as an executable — exit code = report success. */
async function main(): Promise<void> {
  const report = await FlowCLI.create(TerminationScenario).run()
  process.exit(report.succeeded ? 0 : 1)
}

void main()
