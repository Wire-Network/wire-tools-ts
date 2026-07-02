import { FlowCLI } from "@wireio/test-cluster-tool"
import { ReserveLifecycleScenario } from "./ReserveLifecycleScenario.js"

/** Run the reserve-lifecycle flow as an executable — exit code = report success. */
async function main(): Promise<void> {
  const report = await FlowCLI.create(ReserveLifecycleScenario).run()
  process.exit(report.succeeded ? 0 : 1)
}

void main()
