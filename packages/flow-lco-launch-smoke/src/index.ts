import { FlowCLI } from "@wireio/cluster-tool"
import { LcoLaunchSmokeScenario } from "./LcoLaunchSmokeScenario.js"

/** Exit from the report verdict after the harness has drained all managed daemons. */
async function main(): Promise<void> {
  const report = await FlowCLI.create(LcoLaunchSmokeScenario).run()
  process.exit(report.succeeded ? 0 : 1)
}

void main()
