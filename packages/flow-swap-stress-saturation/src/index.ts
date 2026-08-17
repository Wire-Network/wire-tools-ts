import { FlowCLI } from "@wireio/cluster-tool"
import { SwapStressSaturationScenario } from "./SwapStressSaturationScenario.js"

/** Run the swap-stress saturation soak as an executable — exit code = report success. */
async function main(): Promise<void> {
  const report = await FlowCLI.create(SwapStressSaturationScenario).run()
  process.exit(report.succeeded ? 0 : 1)
}

void main()
