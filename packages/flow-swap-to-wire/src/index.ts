import { FlowCLI } from "@wireio/cluster-tool"
import { SwapToWireScenario } from "./SwapToWireScenario.js"

/** Run the swap-to-WIRE flow as an executable — exit code = report success. */
async function main(): Promise<void> {
  const report = await FlowCLI.create(SwapToWireScenario).run()
  process.exit(report.succeeded ? 0 : 1)
}

void main()
