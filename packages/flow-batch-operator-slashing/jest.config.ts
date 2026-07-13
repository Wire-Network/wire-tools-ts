const config = {
  displayName: "flow-batch-operator-slashing",
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
    "^@wireio/test-flow-batch-operator-slashing/(.*)\\.js$": "<rootDir>/src/$1",
    "^@wireio/test-flow-batch-operator-slashing/(.*)$": "<rootDir>/src/$1"
  }
}

export default config
