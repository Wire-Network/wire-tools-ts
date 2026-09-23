import { FlowCLI } from "@wireio/cluster-tool"
import { ClusterReadinessScenario } from "./ClusterReadinessScenario.js"

/** Run the fresh-cluster readiness FlowScenario; exit code mirrors the native Report. */
async function main(): Promise<void> {
  const report = await FlowCLI.create(ClusterReadinessScenario).run()
  process.exit(report.succeeded ? 0 : 1)
}

void main()
