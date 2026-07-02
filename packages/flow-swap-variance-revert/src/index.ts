import { FlowCLI } from "@wireio/test-cluster-tool"
import { SwapVarianceRevertScenario } from "./SwapVarianceRevertScenario.js"

/** Run the swap variance-revert flow as an executable — exit code = report success. */
async function main(): Promise<void> {
  const report = await FlowCLI.create(SwapVarianceRevertScenario).run()
  process.exit(report.succeeded ? 0 : 1)
}

void main()
