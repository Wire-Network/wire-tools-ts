// flow-node-owner-nft — bootstraps a fresh cluster, mints a MockWireNodes
// NFT on ETH, links the depositor's EM key via sysio.authex, and exercises
// sysio.roa::nodeownreg from PR #359 (happy path + the 6 negative cases
// the patch's own unit tests cover). 30-min ceiling is plenty for bootstrap
// + the per-test action round-trips.
const config = {
  displayName: "flow-node-owner-nft",
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
