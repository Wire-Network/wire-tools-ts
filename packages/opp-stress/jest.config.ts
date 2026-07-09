const config = {
  displayName: "opp-stress",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
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
    "^@wireio/test-opp-stress$": "<rootDir>/src/index",
    "^@wireio/debugging-shared$": "<rootDir>/../debugging-shared/src/index",
    "^@wireio/debugging-shared/(.*)\\.js$":
      "<rootDir>/../debugging-shared/src/$1",
    "^@wireio/debugging-shared/(.*)$": "<rootDir>/../debugging-shared/src/$1"
  },
  transformIgnorePatterns: ["node_modules/(?!@wireio/opp-typescript-models)"]
}

export default config
