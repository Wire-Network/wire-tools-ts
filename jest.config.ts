import type { Config } from "jest"

const config: Config = {
  // In multi-project mode jest honors testTimeout from the ROOT config only —
  // the per-project value (cluster-tool/jest.config.ts, same rationale) is
  // ignored here.
  //
  // Sized to the LOADED-HOST worst case for a port-resolving test, per
  // STYLE.md "Timing Budgets". The cost is real probing, not waiting:
  // `ClusterConfigProvider.resolve` claims every daemon port (each TCP-probed,
  // UDP-role ones probed twice) and `findAvailableRange` sweeps 64-port
  // windows. The first resolve in a process makes about 795 binds, a later one
  // in the same process about 1,500.
  //
  // A host can serialize `bind()`, so the worst case is set by how many
  // port-resolving processes bind AT ONCE. On WSL2 with mirrored networking a
  // bind costs about 10 ms alone and the cost grows linearly with concurrent
  // binders: about 135 ms each with 13 (the port-resolving suites of a full
  // run, which start together) and about 324 ms each with 31 (the worker
  // bound, cores - 1). Measured: with 13 binding, a process's first resolve
  // took 120-135 s. 360s covers that FIRST concurrent resolve of a process up
  // to the 31-binder bound. Source: the H1 debug measurements (2026-09-29).
  //
  // An undershot ceiling does NOT fail cleanly here, which is why this is
  // sized generously rather than trimmed: a test killed mid-`withFileLock`
  // leaves `proper-lockfile`'s refresh timer holding the port lock while the
  // suite's fixture removes its temp registry dir, and the `onCompromised`
  // hook then throws `ENOENT … wire-cluster-ports.lock.lock` — a second,
  // unrelated-looking failure class produced entirely by the first.
  //
  // A generous ceiling adds no wall clock to a healthy run: a passing test
  // returns the moment it finishes.
  testTimeout: 360_000,
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
