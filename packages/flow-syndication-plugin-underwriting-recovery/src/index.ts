import "source-map-support/register"
import { FlowCLI } from "@wireio/cluster-tool"
import { SyndicationPluginUnderwritingRecoveryScenario } from "./SyndicationPluginUnderwritingRecoveryScenario.js"

/** Execute the recovery flow and return its Report verdict. */
async function main(): Promise<void> {
  const report = await FlowCLI.create(SyndicationPluginUnderwritingRecoveryScenario).run()
  process.exit(report.succeeded ? 0 : 1)
}
void main()
