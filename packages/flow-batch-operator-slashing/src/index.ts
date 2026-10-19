import { BatchOperatorSlashingScenario, FlowCLI } from "@wireio/cluster-tool"

/** Run the batch-operator-slashing flow as an executable — exit code = report success. */
async function main(): Promise<void> {
  const report = await FlowCLI.create(BatchOperatorSlashingScenario).run()
  process.exit(report.succeeded ? 0 : 1)
}

void main()
