import { FlowCLI } from "@wireio/cluster-tool"
import { DepotPacedEpochsScenario } from "./DepotPacedEpochsScenario.js"

/** Run the depot-paced-epochs flow as an executable — exit code = report success. */
async function main(): Promise<void> {
  const report = await FlowCLI.create(DepotPacedEpochsScenario).run()
  process.exit(report.succeeded ? 0 : 1)
}

void main()
