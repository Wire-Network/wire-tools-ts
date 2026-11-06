import { FlowCLI } from "@wireio/cluster-tool"

import { SolanaGenesisSnapshotScenario } from "./SolanaGenesisSnapshotScenario.js"

/** Execute the live Solana genesis scenario; the Report determines the exit status. */
async function main(): Promise<void> {
  const report = await FlowCLI.create(SolanaGenesisSnapshotScenario).run()
  process.exit(report.succeeded ? 0 : 1)
}

void main()
