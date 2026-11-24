import { FlowCLI } from "@wireio/cluster-tool"
import { EconomicClockScenario } from "./EconomicClockScenario.js"

/** Run the economic-clock flow as an executable — exit code = report success. */
async function main(): Promise<void> {
  const report = await FlowCLI.create(EconomicClockScenario).run()
  process.exit(report.succeeded ? 0 : 1)
}

void main()
