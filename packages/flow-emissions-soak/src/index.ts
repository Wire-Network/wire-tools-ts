import { FlowCLI } from "@wireio/cluster-tool"
import { EmissionsSoakScenario } from "./EmissionsSoakScenario.js"

/** Run the emissions-soak flow as an executable — exit code = report success. */
async function main(): Promise<void> {
  const report = await FlowCLI.create(EmissionsSoakScenario).run()
  process.exit(report.succeeded ? 0 : 1)
}

void main()
