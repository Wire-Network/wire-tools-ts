import { FlowCLI } from "@wireio/cluster-tool"
import { SwapPrivateReservesScenario } from "./SwapPrivateReservesScenario.js"

/** Run the private-reserve swap flow as an executable — exit code = report success. */
async function main(): Promise<void> {
  const report = await FlowCLI.create(SwapPrivateReservesScenario).run()
  process.exit(report.succeeded ? 0 : 1)
}

void main()
