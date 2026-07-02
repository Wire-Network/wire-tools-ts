const config = {
  displayName: "test-cluster-tool",
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
    "^@wireio/test-cluster-tool$": "<rootDir>/src/index",
    "^@wireio/test-cluster-tool/(.*)$": "<rootDir>/src/$1"
  }
}

export default config
