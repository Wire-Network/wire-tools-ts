import { FlowCLI } from "@wireio/cluster-tool"
import { LiqSyndicationScenario } from "./LiqSyndicationScenario.js"

/** Run the liq-syndication flow as an executable — exit code = report success. */
async function main(): Promise<void> {
  const report = await FlowCLI.create(LiqSyndicationScenario).run()
  process.exit(report.succeeded ? 0 : 1)
}

void main()
