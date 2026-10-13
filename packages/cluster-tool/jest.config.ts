const config = {
  displayName: "cluster-tool",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
  // Sized to the loaded-host worst case for a port-resolving test (STYLE.md
  // "Timing Budgets"): 360s covers the FIRST concurrent resolve of a process,
  // about 795 binds at up to ~324 ms each when 31 processes bind at once.
  // Kept in sync with the ROOT jest.config.ts, which is the value
  // multi-project mode actually honors; see its comment for the measurements.
  testTimeout: 360_000,
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
