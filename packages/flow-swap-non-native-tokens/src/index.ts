import { FlowCLI } from "@wireio/test-cluster-tool"
import { SwapNonNativeScenario } from "./SwapNonNativeScenario.js"

/** Run the non-native-token swap flow as an executable — exit code = report success. */
async function main(): Promise<void> {
  const report = await FlowCLI.create(SwapNonNativeScenario).run()
  process.exit(report.succeeded ? 0 : 1)
}

void main()
