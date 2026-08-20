const config = {
  displayName: "cluster-tool",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
  // Sized to the loaded-host worst case for a port-resolving test (STYLE.md
  // "Timing Budgets"): `ClusterConfigProvider.resolve` TCP/UDP-probes every
  // daemon port and `findAvailableRange` sweeps a 64-port window — ~15s per
  // test even standalone. Kept in sync with the ROOT jest.config.ts, which is
  // the value multi-project mode actually honors; see its comment for why.
  testTimeout: 120_000,
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
    "^@wireio/cluster-tool-shared$": "<rootDir>/../cluster-tool-shared/src/index",
    "^@wireio/cluster-tool-shared/(.*)$": "<rootDir>/../cluster-tool-shared/src/$1",
    "^@wireio/cluster-tool$": "<rootDir>/src/index",
    "^@wireio/cluster-tool/(.*)$": "<rootDir>/src/$1"
  }
}

export default config
