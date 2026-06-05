// Emissions soak — default 30-min sampling window (override via
// `SOAK_DURATION_MS`). The long soak test sets its own per-test timeout
// (`SOAK_DURATION_MS + 30min`); this config-level ceiling is the default
// for the shorter bootstrap / import / claim tests.
const config = {
  displayName: "flow-emissions-soak",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
  // 1h ceiling — covers the 30-min soak plus bootstrap / import / teardown
  // with headroom for slower hosts. The soak test overrides per-test.
  testTimeout: 60 * 60 * 1000,
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        tsconfig: "<rootDir>/../../etc/tsconfig/tsconfig.base.jest.json"
      }
    ],
    "^.+\\.js$": "<rootDir>/../../etc/jest/esm-transformer.cjs"
  },
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
    "^@wireio/test-cluster-tool$": "<rootDir>/../test-cluster-tool/src/index",
    "^@wireio/test-cluster-tool/(.*)$": "<rootDir>/../test-cluster-tool/src/$1"
  },
  modulePaths: ["<rootDir>/../test-cluster-tool/node_modules"],
  transformIgnorePatterns: [
    "node_modules/(?!@wireio/opp-typescript-models)"
  ]
}

export default config
