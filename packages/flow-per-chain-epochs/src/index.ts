import { FlowCLI } from "@wireio/cluster-tool"
import { PerChainEpochsScenario } from "./PerChainEpochsScenario.js"

/** Run the per-chain-epochs flow as an executable — exit code = report success. */
async function main(): Promise<void> {
  const report = await FlowCLI.create(PerChainEpochsScenario).run()
  process.exit(report.succeeded ? 0 : 1)
}

void main()
