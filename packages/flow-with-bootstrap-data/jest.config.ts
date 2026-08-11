const config = {
  displayName: "flow-with-bootstrap-data",
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
    "^@wireio/cluster-tool$": "<rootDir>/../cluster-tool/src/index",
    "^@wireio/cluster-tool/(.*)$": "<rootDir>/../cluster-tool/src/$1",
    "^@wireio/test-flow-with-bootstrap-data/(.*)\\.js$": "<rootDir>/src/$1",
    "^@wireio/test-flow-with-bootstrap-data/(.*)$": "<rootDir>/src/$1"
  }
}

export default config
