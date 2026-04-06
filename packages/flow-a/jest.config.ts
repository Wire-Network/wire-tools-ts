const config = {
  displayName: "flow-a",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
  testTimeout: 120_000,
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
    "^@wire-e2e-tests/harness$": "<rootDir>/../harness/src/index",
    "^@wire-e2e-tests/harness/(.*)$": "<rootDir>/../harness/src/$1"
  },
  modulePaths: ["<rootDir>/../harness/node_modules"],
  transformIgnorePatterns: [
    "node_modules/(?!@wireio/opp-solidity-models)"
  ]
}

export default config
