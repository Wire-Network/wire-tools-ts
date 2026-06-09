import type { Config } from "jest"

const config: Config = {
  projects: [
    "packages/test-cluster-tool",
    "packages/flow-operator-collateral-deposit",
    "packages/flow-swap-with-underwriting",
    "packages/flow-batch-operator-termination",
    "packages/flow-batch-operator-slashing",
    "packages/flow-swap-variance-revert",
    "packages/flow-swap-non-native-tokens",
    "packages/debugging-shared",
    "packages/debugging-server",
    "packages/debugging-client-shared",
    "packages/debugging-client-tool",
    "packages/debugging-client-tool-tui"
  ]
}

export default config
