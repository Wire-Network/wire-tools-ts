import type { Config } from "jest"

const config: Config = {
  // In multi-project mode jest honors testTimeout from the ROOT config only —
  // the per-project value (cluster-tool/jest.config.ts, same rationale) is
  // ignored here. Port-resolving tests queue behind the ONE host-global port
  // lock (`BindConfigProvider.findAvailable` → withFileLock, worst-case wait
  // ~25s under the full 8-project run); jest's 5s default fails
  // healthy-but-queued tests, and a generous ceiling adds no wall clock to a
  // healthy run (STYLE.md "Timing Budgets").
  testTimeout: 30_000,
  projects: [
    "packages/cluster-tool-shared",
    "packages/cluster-tool",
    "packages/flow-batch-operator-slashing",
    "packages/flow-with-bootstrap-data",
    "packages/debugging-shared",
    "packages/debugging-server",
    "packages/debugging-client-shared",
    "packages/debugging-client-tool",
    "packages/debugging-client-tool-tui"
  ]
}

export default config
