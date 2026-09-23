import { FlowCLI } from "@wireio/cluster-tool"
import { ProducerRegistrationScenario } from "./ProducerRegistrationScenario.js"

/** Run the producer-registration flow as an executable — exit code = report success. */
async function main(): Promise<void> {
  const report = await FlowCLI.create(ProducerRegistrationScenario).run()
  process.exit(report.succeeded ? 0 : 1)
}

void main()
