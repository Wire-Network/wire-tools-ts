import type { Config } from "jest"

const config: Config = {
  projects: [
    "packages/cluster-tool",
    "packages/debugging-shared",
    "packages/debugging-server",
    "packages/debugging-client-shared",
    "packages/debugging-client-tool",
    "packages/debugging-client-tool-tui"
  ]
}

export default config
