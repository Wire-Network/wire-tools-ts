import { FlowCLI } from "@wireio/cluster-tool"
import { CollateralLifecycleScenario } from "./CollateralLifecycleScenario.js"

/** Run the collateral-lifecycle flow as an executable — exit code = report success. */
async function main(): Promise<void> {
  const report = await FlowCLI.create(CollateralLifecycleScenario).run()
  process.exit(report.succeeded ? 0 : 1)
}

void main()
