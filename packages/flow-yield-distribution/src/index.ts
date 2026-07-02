import { FlowCLI } from "@wireio/test-cluster-tool"
import { YieldDistributionScenario } from "./YieldDistributionScenario.js"

/** Run the yield-distribution flow as an executable — exit code = report success. */
async function main(): Promise<void> {
  const report = await FlowCLI.create(YieldDistributionScenario).run()
  process.exit(report.succeeded ? 0 : 1)
}

void main()
