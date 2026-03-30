const config = {
  displayName: "harness",
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
    "^@wire-e2e-tests/harness$": "<rootDir>/src/index",
    "^@wire-e2e-tests/harness/(.*)$": "<rootDir>/src/$1"
  }
}

export default config
