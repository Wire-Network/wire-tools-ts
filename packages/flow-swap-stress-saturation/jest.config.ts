const config = {
  displayName: "flow-swap-stress-saturation",
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
    "^@wireio/test-flow-swap-stress-saturation$": "<rootDir>/src/index",
    "^@wireio/test-cluster-tool$": "<rootDir>/../test-cluster-tool/src/index",
    "^@wireio/test-cluster-tool/(.*)\\.js$":
      "<rootDir>/../test-cluster-tool/src/$1",
    "^@wireio/test-cluster-tool/(.*)$": "<rootDir>/../test-cluster-tool/src/$1",
    "^@wireio/debugging-shared$": "<rootDir>/../debugging-shared/src/index",
    "^@wireio/debugging-shared/(.*)\\.js$":
      "<rootDir>/../debugging-shared/src/$1",
    "^@wireio/debugging-shared/(.*)$": "<rootDir>/../debugging-shared/src/$1"
  },
  modulePaths: ["<rootDir>/../test-cluster-tool/node_modules"],
  transformIgnorePatterns: ["node_modules/(?!@wireio/opp-typescript-models)"]
}

export default config
