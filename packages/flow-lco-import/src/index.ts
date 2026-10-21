import { FlowCLI } from "@wireio/cluster-tool"
import { LcoImportScenario } from "./LcoImportScenario.js"

/** Run the launch-data import flow as an executable — exit code = report success. */
async function main(): Promise<void> {
  const report = await FlowCLI.create(LcoImportScenario).run()
  process.exit(report.succeeded ? 0 : 1)
}

void main()
