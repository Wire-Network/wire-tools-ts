const config = {
  displayName: "flow-d",
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
    ]
  },
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
    "^@wire-e2e-tests/harness$": "<rootDir>/../harness/src/index",
    "^@wire-e2e-tests/harness/(.*)$": "<rootDir>/../harness/src/$1"
  },
  modulePaths: ["<rootDir>/../harness/node_modules"]
}

export default config
