import { FlowCLI } from "@wireio/cluster-tool"
import { SwapFromWireScenario } from "./SwapFromWireScenario.js"

/** Run the swap-from-WIRE flow as an executable — exit code = report success. */
async function main(): Promise<void> {
  const report = await FlowCLI.create(SwapFromWireScenario).run()
  process.exit(report.succeeded ? 0 : 1)
}

void main()
