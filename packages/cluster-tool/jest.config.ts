const config = {
  displayName: "cluster-tool",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
  // Port-resolving tests queue behind the ONE host-global port lock
  // (`BindConfigProvider.findAvailable` → withFileLock, worst-case wait ~25s
  // under the full multi-project run) — jest's 5s default is an undershot
  // ceiling that fails healthy-but-queued tests; a generous ceiling adds no
  // wall clock to a healthy run (see STYLE.md "Timing Budgets").
  testTimeout: 30_000,
  setupFiles: ["<rootDir>/tests/jest.setup.ts"],
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        tsconfig: "<rootDir>/../../etc/tsconfig/tsconfig.base.jest.json"
      }
    ]
  },
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
    "^@wireio/cluster-tool-shared$":
      "<rootDir>/../cluster-tool-shared/src/index",
    "^@wireio/cluster-tool-shared/(.*)$":
      "<rootDir>/../cluster-tool-shared/src/$1",
    "^@wireio/cluster-tool$": "<rootDir>/src/index",
    "^@wireio/cluster-tool/(.*)$": "<rootDir>/src/$1"
  }
}

export default config
