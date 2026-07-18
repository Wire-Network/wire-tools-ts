const config = {
  displayName: "debugging-client-tool",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
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
    "^@wireio/cluster-tool-shared$":
      "<rootDir>/../cluster-tool-shared/src/index",
    "^@wireio/cluster-tool-shared/(.*)$":
      "<rootDir>/../cluster-tool-shared/src/$1",
    "^@wireio/debugging-client-tool$": "<rootDir>/src/index",
    "^@wireio/debugging-client-tool/(.*)$": "<rootDir>/src/$1",
    "^@wireio/debugging-shared$": "<rootDir>/../debugging-shared/src/index",
    "^@wireio/debugging-shared/(.*)$": "<rootDir>/../debugging-shared/src/$1",
    "^@wireio/debugging-client-shared$":
      "<rootDir>/../debugging-client-shared/src/index",
    "^@wireio/debugging-client-shared/(.*)$":
      "<rootDir>/../debugging-client-shared/src/$1"
  }
}

export default config
