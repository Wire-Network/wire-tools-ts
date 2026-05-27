// Yield-distribution flow — bootstraps a fresh cluster, drives fake
// STAKING_REWARD attestations through both outposts, and asserts the
// depot's onreward → fundclaim path matches accounting + balance caps.
// Bootstrap (~2min) + a few epoch waits dominate the runtime; a 30-min
// ceiling is plenty for the per-test bound.
const config = {
  displayName: "flow-yield-distribution",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
  testTimeout: 30 * 60 * 1000,
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
