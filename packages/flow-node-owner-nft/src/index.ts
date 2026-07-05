import { FlowCLI } from "@wireio/cluster-tool"
import { NodeOwnerNftScenario } from "./NodeOwnerNftScenario.js"

/** Run the node-owner NFT flow as an executable — exit code = report success. */
async function main(): Promise<void> {
  const report = await FlowCLI.create(NodeOwnerNftScenario).run()
  process.exit(report.succeeded ? 0 : 1)
}

void main()
