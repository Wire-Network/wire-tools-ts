const config = {
  displayName: "ql-tool-cli",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts", "**/*.test.tsx"],
  setupFiles: ["<rootDir>/tests/jest.setup.ts"],
  setupFilesAfterEnv: ["<rootDir>/tests/jest.afterEnv.ts"],
  transform: {
    // yargs ≥ 18 is ESM-only (import.meta in its platform shim): "yargs" maps to a
    // CommonJS stand-in that esbuild replaces with a bundle of the REAL package, so
    // parser behavior (conflicts, checks) is tested, not mocked.
    "\\.jest\\.cjs$": "<rootDir>/scripts/esbuild/jestEsmBundleTransformer.cjs",
    // Workspace CommonJS packages (ql-shared, cluster-tool, …) compile exactly as in
    // their own jest configs (nodenext keeps their `import()` of ESM-only deps such
    // as get-port a real dynamic import). Mapped paths arrive un-normalized
    // (`ql-tool-cli/../cluster-tool/src/…`), hence the src|tests anchor.
    "^(?!.*[\\\\/]ql-tool-cli[\\\\/](src|tests)[\\\\/]).+\\.tsx?$": [
      "ts-jest",
      { tsconfig: "<rootDir>/../../etc/tsconfig/tsconfig.base.jest.json" }
    ],
    // This package (`type: module`): esbuild → CommonJS (see the transformer's doc).
    "^.+\\.tsx?$": "<rootDir>/scripts/esbuild/jestTypeScriptTransformer.cjs"
  },
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
    "^yargs$": "<rootDir>/scripts/esbuild/yargs.jest.cjs",
    "^@wireio/cluster-tool-shared$": "<rootDir>/../cluster-tool-shared/src/index",
    "^@wireio/cluster-tool-shared/(.*)$": "<rootDir>/../cluster-tool-shared/src/$1",
    "^@wireio/cluster-tool$": "<rootDir>/../cluster-tool/src/index",
    "^@wireio/cluster-tool/(.*)$": "<rootDir>/../cluster-tool/src/$1",
    "^@wireio/ql-shared$": "<rootDir>/../ql-shared/src/index",
    "^@wireio/ql-shared/(.*)$": "<rootDir>/../ql-shared/src/$1",
    "^@wireio/ql-tool-cli$": "<rootDir>/src/cli/index",
    "^@wireio/ql-tool-cli/(.*)\\.js$": "<rootDir>/src/$1",
    "^@wireio/ql-tool-cli/(.*)$": "<rootDir>/src/$1"
  }
}

export default config
