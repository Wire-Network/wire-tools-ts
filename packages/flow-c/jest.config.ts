const config = {
  displayName: "flow-c",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
  testTimeout: 300_000, // 5 min — multi-epoch flow
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
    "node_modules/(?!@wireio/opp-solidity-models)",
    "node_modules/(?!@wireio/opp-typescript-models)"
  ]
}

export default config
