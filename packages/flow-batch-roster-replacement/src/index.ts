import { FlowCLI } from "@wireio/cluster-tool"
import { BatchRosterReplacementScenario } from "./BatchRosterReplacementScenario.js"

/** Exit from the report verdict after the harness has drained all managed daemons. */
async function main(): Promise<void> {
  const report = await FlowCLI.create(BatchRosterReplacementScenario).run()
  process.exit(report.succeeded ? 0 : 1)
}

void main()
