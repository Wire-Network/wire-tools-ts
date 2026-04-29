import type { Config } from "jest"

const config: Config = {
  projects: [
    "packages/test-cluster-tool",
    "packages/flow-a",
    "packages/flow-b",
    "packages/flow-c",
    "packages/debugging-shared",
    "packages/debugging-server",
    "packages/debugging-client-shared",
    "packages/debugging-client-tool",
    "packages/debugging-client-tool-tui"
  ]
}

export default config
