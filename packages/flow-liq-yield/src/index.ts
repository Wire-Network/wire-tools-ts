import { FlowCLI } from "@wireio/cluster-tool"
import { LIQYieldScenario } from "./LIQYieldScenario.js"

/** Run the liq-yield flow as an executable — exit code = report success. */
async function main(): Promise<void> {
  const report = await FlowCLI.create(LIQYieldScenario).run()
  process.exit(report.succeeded ? 0 : 1)
}

void main()
