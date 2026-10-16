import { FlowCLI } from "@wireio/cluster-tool"
import { EthereumGoLiveScenario } from "./EthereumGoLiveScenario.js"

/** Run the ethereum-go-live flow as an executable — exit code = report success. */
async function main(): Promise<void> {
  const report = await FlowCLI.create(EthereumGoLiveScenario).run()
  process.exit(report.succeeded ? 0 : 1)
}

void main()
