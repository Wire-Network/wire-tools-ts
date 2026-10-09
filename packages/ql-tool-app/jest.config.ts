const config = {
  displayName: "ql-tool-app",
  // Renderer component suites opt into jsdom per file (`@jest-environment jsdom`
  // docblock); tests/renderer/query stays on node (jsdom has no MessageChannel —
  // those suites use node:worker_threads ports).
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts", "**/*.test.tsx"],
  setupFiles: ["<rootDir>/tests/jest.globals.ts", "<rootDir>/tests/jest.setup.ts"],
  setupFilesAfterEnv: ["<rootDir>/tests/jest.afterEnv.ts"],
  transform: {
    "^.+\\.(ts|tsx)$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.cjs.jest.json" }],
    "^.+\\.m?js$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.cjs.jest.json", isolatedModules: true, useESM: true }]
  },
  // TanStack ships ESM only — transform it (reached by renderer components).
  transformIgnorePatterns: ["/node_modules/(?!(\\.pnpm/[^/]*/node_modules/)?@tanstack/)"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
    "^electron$": "<rootDir>/tests/__mocks__/electron.ts",
    "^monaco-editor(/.*)?$": "<rootDir>/tests/__mocks__/monaco-editor.ts",
    "^@monaco-editor/react$": "<rootDir>/tests/__mocks__/@monaco-editor/react.tsx",
    "^@tanstack/react-virtual$": "<rootDir>/tests/__mocks__/@tanstack/react-virtual.ts",
    "^@wireio/ql-tool-app/(.*)$": "<rootDir>/src/$1",
    "^@wireio/ql-shared$": "<rootDir>/../ql-shared/src/index",
    "^@wireio/ql-shared/(.*)$": "<rootDir>/../ql-shared/src/$1",
    "^@wireio/cluster-tool-shared$": "<rootDir>/../cluster-tool-shared/src/index",
    "^@wireio/cluster-tool-shared/(.*)$": "<rootDir>/../cluster-tool-shared/src/$1",
    "^@wireio/cluster-tool$": "<rootDir>/../cluster-tool/src/index",
    "^@wireio/cluster-tool/(.*)$": "<rootDir>/../cluster-tool/src/$1"
  }
}

export default config
