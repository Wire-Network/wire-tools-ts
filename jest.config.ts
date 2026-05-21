import type { Config } from "jest"

const config: Config = {
  projects: [
    "packages/test-cluster-tool",
    "packages/flow-empty-epoch-balance-sheet",
    "packages/flow-operator-collateral-deposit",
    "packages/flow-swap-with-underwriting",
    "packages/flow-batch-operator-termination",
    "packages/flow-swap-variance-revert",
    "packages/debugging-shared",
    "packages/debugging-server",
    "packages/debugging-client-shared",
    "packages/debugging-client-tool",
    "packages/debugging-client-tool-tui"
  ]
}

export default config
