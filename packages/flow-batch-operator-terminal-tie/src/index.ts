import { FlowCLI } from "@wireio/cluster-tool"
import { TerminalTieScenario } from "./TerminalTieScenario.js"

/** Run the terminal two-candidate dispute flow — exit code = report success. */
async function main(): Promise<void> {
  const report = await FlowCLI.create(TerminalTieScenario).run()
  process.exit(report.succeeded ? 0 : 1)
}

void main()
