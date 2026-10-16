import { FlowCLI } from "@wireio/cluster-tool"
import { BatchRelayRestartScenario } from "./BatchRelayRestartScenario.js"

/** Exit from the report verdict after the harness has drained all managed daemons. */
async function main(): Promise<void> {
  const report = await FlowCLI.create(BatchRelayRestartScenario).run()
  process.exit(report.succeeded ? 0 : 1)
}

void main()
