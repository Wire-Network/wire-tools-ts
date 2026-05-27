// Multi-hour soak — timeout is hours, not minutes. Override per-test via
// `jest.setTimeout(...)` inside the test if a finer bound is wanted.
const config = {
  displayName: "flow-emissions-soak",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
  // 4h ceiling — covers the documented 2h soak plus startup/teardown
  // and gives headroom for slower hosts. Individual flows override.
  testTimeout: 4 * 60 * 60 * 1000,
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
