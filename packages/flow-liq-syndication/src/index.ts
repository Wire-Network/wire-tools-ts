import { FlowCLI } from "@wireio/cluster-tool"
import { LIQSyndicationScenario } from "./LIQSyndicationScenario.js"

/** Run the liq-syndication flow as an executable — exit code = report success. */
async function main(): Promise<void> {
  const report = await FlowCLI.create(LIQSyndicationScenario).run()
  process.exit(report.succeeded ? 0 : 1)
}

void main()
