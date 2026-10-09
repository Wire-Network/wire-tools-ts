import Path from "node:path"

/** The members of `etc/app-identity/app-identity.cjs` the e2e paths read. */
interface AppIdentityPaths {
  /** The package directory. */
  PackagePath: string
}

/**
 * Where the e2e suite and its Playwright configuration find the package and put
 * their output. The package root is the app identity's own `PackagePath` (the
 * module webpack and electron-builder read), so every consumer resolves it the same way.
 */
export namespace E2EPaths {
  /** The app identity module, relative to this file (tests/e2e/common/). */
  export const AppIdentityFile = Path.join(__dirname, "..", "..", "..", "etc", "app-identity", "app-identity.cjs")
  /** The package directory. */
  export const PackagePath = (require(AppIdentityFile) as AppIdentityPaths).PackagePath
  /** Test reports and runner output (the package-root layout's home for them). */
  export const TestResultsPath = Path.join(PackagePath, "dist", "test-results")
  /** Playwright's `outputDir` — a subdirectory, since Playwright wipes it before globalSetup runs. */
  export const PlaywrightOutputPath = Path.join(TestResultsPath, "playwright")
  /** The e2e suite directory. */
  export const SuitePath = Path.join(PackagePath, "tests", "e2e")
}
