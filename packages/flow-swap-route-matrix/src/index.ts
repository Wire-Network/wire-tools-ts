import { FlowCLI } from "@wireio/cluster-tool"
import { SwapRouteMatrixScenario } from "./SwapRouteMatrixScenario.js"

/** Run the native swap-route matrix; the process exits non-zero on any failed route step. */
async function main(): Promise<void> {
  const report = await FlowCLI.create(SwapRouteMatrixScenario).run()
  process.exit(report.succeeded ? 0 : 1)
}

void main()
