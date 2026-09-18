import { FlowCLI } from "@wireio/cluster-tool"
import { SwapEpochStressScenario } from "./SwapEpochStressScenario.js"

async function main(): Promise<void> {
  const report = await FlowCLI.create(SwapEpochStressScenario).run()
  process.exit(report.succeeded ? 0 : 1)
}

void main()
