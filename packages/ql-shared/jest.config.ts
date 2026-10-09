const config = {
  displayName: "ql-shared",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
  setupFiles: ["<rootDir>/tests/jest.setup.ts"],
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
    "^@wireio/cluster-tool$": "<rootDir>/../cluster-tool/src/index",
    "^@wireio/cluster-tool/(.*)$": "<rootDir>/../cluster-tool/src/$1",
    "^@wireio/ql-shared$": "<rootDir>/src/index",
    "^@wireio/ql-shared/(.*)$": "<rootDir>/src/$1"
  }
}

export default config
