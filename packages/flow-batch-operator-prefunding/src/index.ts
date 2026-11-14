import "source-map-support/register"
import { FlowCLI } from "@wireio/cluster-tool"
import { BatchOperatorPrefundingScenario } from "./BatchOperatorPrefundingScenario.js"

/** Run the pre-funded launch flow as an executable — exit code = report success. */
async function main(): Promise<void> {
  const report = await FlowCLI.create(BatchOperatorPrefundingScenario).run()
  process.exit(report.succeeded ? 0 : 1)
}

void main()
