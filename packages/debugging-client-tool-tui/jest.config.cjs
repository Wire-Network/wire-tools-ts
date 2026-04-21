// Plain CJS config — the package is `type: module`, but jest loads its
// config via Node's module loader which would try to parse a .js or .ts
// file as ESM and confuse ts-jest's transform. `.cjs` forces CommonJS
// resolution regardless of the parent package.json's `type` field.

/** @type {import("jest").Config} */
const config = {
  displayName: "debugging-client-tool-tui",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts", "**/*.test.tsx"],
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        tsconfig: "<rootDir>/../../etc/tsconfig/tsconfig.base.jest.json"
      }
    ]
  },
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
    "^@wire-e2e-tests/debugging-client-tool-tui$": "<rootDir>/src/tui",
    "^@wire-e2e-tests/debugging-client-tool-tui/(.*)$": "<rootDir>/src/$1",
    "^@wire-e2e-tests/debugging-shared$": "<rootDir>/../debugging-shared/src/index",
    "^@wire-e2e-tests/debugging-shared/(.*)$": "<rootDir>/../debugging-shared/src/$1",
    "^@wire-e2e-tests/debugging-client-shared$": "<rootDir>/../debugging-client-shared/src/index",
    "^@wire-e2e-tests/debugging-client-shared/(.*)$": "<rootDir>/../debugging-client-shared/src/$1"
  }
}

module.exports = config
