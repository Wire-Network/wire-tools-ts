const config = {
  displayName: "opp-stress-harness",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
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
    "^@wireio/opp-stress-harness$": "<rootDir>/src/index",
    "^@wireio/opp-stress-harness/(.*)$": "<rootDir>/src/$1",
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
