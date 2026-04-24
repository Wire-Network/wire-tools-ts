const config = {
  displayName: "debugging-client-tool-tui",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts", "**/*.test.tsx"],
  setupFiles: ["<rootDir>/tests/jest.setup.ts"],
  transform: {
    "^.+\\.(ts|tsx)$": [
      "ts-jest",
      {
        tsconfig: "<rootDir>/tsconfig.cjs.jest.json"
      }
    ],
    "^.+\\.m?js$": [
      "ts-jest",
      {
        tsconfig: "<rootDir>/tsconfig.cjs.jest.json",
        isolatedModules: true
      }
    ]
  },
  // Transform ESM-only deps (yargs is ESM since v18) so tests running in the
  // package's `type: module` context can still load them under jest's CJS runtime.
  transformIgnorePatterns: [
    "/node_modules/(?!(yargs|yargs-parser|cliui|string-width|strip-ansi|ansi-regex|wrap-ansi|ansi-styles|emoji-regex)/)"
  ],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
    "^@wire-e2e-tests/debugging-client-tool-tui$": "<rootDir>/src/tui",
    "^@wire-e2e-tests/debugging-client-tool-tui/(.*)\\.js$":
      "<rootDir>/src/$1",
    "^@wire-e2e-tests/debugging-client-tool-tui/(.*)$": "<rootDir>/src/$1",
    "^@wire-e2e-tests/debugging-shared$":
      "<rootDir>/../debugging-shared/src/index",
    "^@wire-e2e-tests/debugging-shared/(.*)\\.js$":
      "<rootDir>/../debugging-shared/src/$1",
    "^@wire-e2e-tests/debugging-shared/(.*)$":
      "<rootDir>/../debugging-shared/src/$1",
    "^@wire-e2e-tests/debugging-client-shared$":
      "<rootDir>/../debugging-client-shared/src/index",
    "^@wire-e2e-tests/debugging-client-shared/(.*)\\.js$":
      "<rootDir>/../debugging-client-shared/src/$1",
    "^@wire-e2e-tests/debugging-client-shared/(.*)$":
      "<rootDir>/../debugging-client-shared/src/$1"
  }
}

export default config
