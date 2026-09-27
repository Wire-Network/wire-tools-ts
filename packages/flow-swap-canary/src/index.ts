import { FlowCLI } from "@wireio/cluster-tool"
import { SwapCanaryScenario } from "./SwapCanaryScenario.js"

/** Run the swap canary through the canonical FlowScenario CLI. */
async function main(): Promise<void> {
  const report = await FlowCLI.create(SwapCanaryScenario).run()
  process.exit(report.succeeded ? 0 : 1)
}

void main()
