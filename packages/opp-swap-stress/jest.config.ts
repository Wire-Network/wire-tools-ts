const config = {
  displayName: "opp-swap-stress",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
  testTimeout: 120_000,
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        tsconfig: "<rootDir>/tsconfig.tests.json"
      }
    ],
    "^.+\\.js$": "<rootDir>/../../etc/jest/esm-transformer.cjs"
  },
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
    "^@wireio/opp-swap-stress$": "<rootDir>/src/index",
    "^@wireio/opp-stress-harness$": "<rootDir>/../opp-stress-harness/src/index",
    "^@wireio/opp-stress-harness/(.*)\\.js$":
      "<rootDir>/../opp-stress-harness/src/$1",
    "^@wireio/opp-stress-harness/(.*)$": "<rootDir>/../opp-stress-harness/src/$1",
    "^@wireio/test-opp-stress$": "<rootDir>/../opp-stress/src/index",
    "^@wireio/test-opp-stress/(.*)\\.js$": "<rootDir>/../opp-stress/src/$1",
    "^@wireio/test-opp-stress/(.*)$": "<rootDir>/../opp-stress/src/$1",
    "^@wireio/debugging-shared$": "<rootDir>/../debugging-shared/src/index",
    "^@wireio/debugging-shared/(.*)\\.js$":
      "<rootDir>/../debugging-shared/src/$1",
    "^@wireio/debugging-shared/(.*)$": "<rootDir>/../debugging-shared/src/$1"
  },
  transformIgnorePatterns: ["node_modules/(?!@wireio/opp-typescript-models)"]
}

export default config
