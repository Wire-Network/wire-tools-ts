import { FlowCLI } from "@wireio/cluster-tool"
import { UnderwriterSlashingScenario } from "./UnderwriterSlashingScenario.js"

/** Run the underwriter-slashing flow as an executable — exit code = report success. */
async function main(): Promise<void> {
  const report = await FlowCLI.create(UnderwriterSlashingScenario).run()
  process.exit(report.succeeded ? 0 : 1)
}

void main()
