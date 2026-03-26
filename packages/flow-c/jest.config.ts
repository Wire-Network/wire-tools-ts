import type { Config } from "jest"

const config: Config = {
  displayName: "flow-c",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
  testTimeout: 300_000, // 5 min — multi-epoch flow
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        tsconfig: "<rootDir>/../../etc/tsconfig/tsconfig.jest.cjs.json",
      },
    ],
  },
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
    "^@wire-e2e-tests/harness$": "<rootDir>/../harness/src/index",
    "^@wire-e2e-tests/harness/(.*)$": "<rootDir>/../harness/src/$1",
  },
  modulePaths: [
    "<rootDir>/../harness/node_modules",
  ],
}

export default config
