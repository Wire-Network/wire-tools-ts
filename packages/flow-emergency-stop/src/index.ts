import "source-map-support/register"
import { FlowCLI } from "@wireio/cluster-tool"
import { EmergencyStopScenario } from "./EmergencyStopScenario.js"

/** Execute the scenario and return the Report verdict. */
async function main(): Promise<void> {
  const report = await FlowCLI.create(EmergencyStopScenario).run()
  process.exit(report.succeeded ? 0 : 1)
}
void main()
