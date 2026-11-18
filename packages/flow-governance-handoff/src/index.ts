import { FlowCLI } from "@wireio/cluster-tool"
import { GovernanceHandoffScenario } from "./GovernanceHandoffScenario.js"

/** Run the governance-handoff flow as an executable — exit code = report success. */
async function main(): Promise<void> {
  const report = await FlowCLI.create(GovernanceHandoffScenario).run()
  process.exit(report.succeeded ? 0 : 1)
}

void main()
