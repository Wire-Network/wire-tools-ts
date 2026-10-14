import { FlowCLI } from "@wireio/cluster-tool"
import { LIQKickerScenario } from "./LIQKickerScenario.js"

/** Run the LIQ kicker flow as an executable — exit code = report success. */
async function main(): Promise<void> {
  const report = await FlowCLI.create(LIQKickerScenario).run()
  process.exit(report.succeeded ? 0 : 1)
}

void main()
