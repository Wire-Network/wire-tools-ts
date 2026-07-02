import { FlowCLI } from "@wireio/test-cluster-tool"
import { SlashingScenario } from "./SlashingScenario.js"

/** Run the batch-operator-slashing flow as an executable — exit code = report success. */
async function main(): Promise<void> {
  const report = await FlowCLI.create(SlashingScenario).run()
  process.exit(report.succeeded ? 0 : 1)
}

void main()
