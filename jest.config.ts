import type { Config } from "jest"

const config: Config = {
  // In multi-project mode jest honors testTimeout from the ROOT config only —
  // the per-project value (cluster-tool/jest.config.ts, same rationale) is
  // ignored here.
  //
  // Sized to the LOADED-HOST worst case for a port-resolving test, per
  // STYLE.md "Timing Budgets". The cost is real probing, not waiting:
  // `ClusterConfigProvider.resolve` claims every daemon port (each TCP-probed,
  // UDP-role ones probed twice) and `findAvailableRange` sweeps a 64-port
  // window — ~15s per test even with the suite running ALONE. Under the full
  // 8-project run that comfortably exceeds a 30s ceiling.
  //
  // 30s was chosen when these tests ALSO queued behind one host-global port
  // lock; that contention is gone (the lock is now keyed per registry — see
  // `BindConfigProvider.portLockPath`), but the probing cost remains and was
  // always the larger half. A generous ceiling adds no wall clock to a healthy
  // run: a passing test returns the moment it finishes.
  testTimeout: 120_000,
  projects: [
    "packages/cluster-tool-shared",
    "packages/cluster-tool",
    "packages/flow-batch-operator-slashing",
    "packages/debugging-shared",
    "packages/debugging-server",
    "packages/debugging-client-shared",
    "packages/debugging-client-tool",
    "packages/debugging-client-tool-tui"
  ]
}

export default config
