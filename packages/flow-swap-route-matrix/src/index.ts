import { FlowCLI } from "@wireio/cluster-tool"
import { SwapRouteMatrixScenario } from "./SwapRouteMatrixScenario.js"

export * from "./SwapRouteMatrixPlan.js"
export * from "./SwapRouteMatrixScenarioConstants.js"

/** Run every configured route; any failed route makes the final verdict non-zero. */
async function main(): Promise<void> {
  const report = await FlowCLI.create(SwapRouteMatrixScenario).run()
  process.exit(report.succeeded ? 0 : 1)
}

void main()
