const config = {
  displayName: "flow-batch-operator-termination",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
  testTimeout: 120_000,
  // forceExit: the Solana web3.js Connection WebSocket (1.98.x) exposes no
  // public close(), so its reconnect/idle timers can outlive teardown and
  // hang jest. This guarantees a clean exit on every path incl. errors; the
  // ETH provider is closed properly in FlowTestContext.teardown().
  forceExit: true,
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
    "^@wireio/test-cluster-tool$": "<rootDir>/../test-cluster-tool/src/index",
    "^@wireio/test-cluster-tool/(.*)$": "<rootDir>/../test-cluster-tool/src/$1"
  },
  modulePaths: ["<rootDir>/../test-cluster-tool/node_modules"],
  transformIgnorePatterns: [
    "node_modules/(?!@wireio/opp-typescript-models)"
  ]
}

export default config
