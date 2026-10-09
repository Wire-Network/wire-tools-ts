import type { Config } from "jest"

const config: Config = {
  // Port-heavy suites compete at the host syscall boundary; CPU-count workers
  // (31 on the development host) multiply probe latency and TS worker memory.
  // Keep the complete suite, with bounded concurrency. CLI --maxWorkers still
  // overrides this when benchmarking on another host.
  maxWorkers: 2,
  // Multi-project Jest honors this ROOT timeout, not per-project values.
  // Keep headroom for loaded WSL hosts: every registry probe is a real syscall,
  // and the longest config suites allocate many complete cluster topologies.
  // Registry locks live outside fixture directories; an actual compromise rejects
  // its owning withFileLock call. Neither protection cancels already-running work.
  // Do not shorten this to hide resource contention; pnpm check also supervises
  // the whole process group.
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
