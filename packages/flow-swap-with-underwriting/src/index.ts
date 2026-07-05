import { FlowCLI } from "@wireio/cluster-tool"
import { SwapWithUnderwritingScenario } from "./SwapWithUnderwritingScenario.js"

/** Run the swap-with-underwriting flow as an executable — exit code = report success. */
async function main(): Promise<void> {
  const report = await FlowCLI.create(SwapWithUnderwritingScenario).run()
  process.exit(report.succeeded ? 0 : 1)
}

void main()
