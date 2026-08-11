import { FlowCLI } from "@wireio/cluster-tool"

import { WithBootstrapDataScenario } from "./WithBootstrapDataScenario.js"

/** Run the fixture-driven bootstrap flow as an executable. */
async function main(): Promise<void> {
  const report = await FlowCLI.create(WithBootstrapDataScenario).run()
  process.exit(report.succeeded ? 0 : 1)
}

void main()
