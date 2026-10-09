#!/usr/bin/env node
/**
 * Verify every workspace package's ROOT holds only the standard layout entries.
 *
 * Allowed at `packages/<name>/`:
 *   files        package.json, README.md, CHANGELOG.md, LICENSE, .gitignore, .npmignore,
 *                tsconfig*.json, jest.config.{ts,js,cjs,mjs},
 *                {webpack,esbuild}.config.{ts,mts,js,mjs,cjs}
 *   directories  src/, tests/, bin/, scripts/, etc/, resources/, lib/, dist/
 *   browser extensions only (a root manifest.json carrying `manifest_version`):
 *                manifest.json, icons/ (a manifest.json that is not valid JSON is not an
 *                extension manifest: it is reported as a violation, with a warning)
 *
 * Everything else has a home inside that set: helper scripts → scripts/<topic>/, tool
 * configuration → etc/<tool>/, node:test / e2e / bench suites → tests/{node,e2e,bench}/,
 * static app files → resources/, test reports → dist/test-results/.
 * Only entries git tracks or would track are inspected (`git ls-files -co --exclude-standard`),
 * so ignored build output and tool state never count.
 *
 * Usage:
 *   ./scripts/check-package-layout.mjs [options]
 *
 * Options:
 *   --repo-path <dir>   repository whose packages/ are checked (default: this repo)
 *
 * Exit codes:
 *   0  every package root is clean
 *   1  at least one package root carries an entry outside the standard (each one is printed)
 *   2  usage error (unknown option, stray argument, valueless --repo-path) / not a git repository
 *
 * Examples:
 *   ./scripts/check-package-layout.mjs
 *   ./scripts/check-package-layout.mjs --repo-path ../wire-libraries-ts
 */

import { $, chalk, echo, fs, path } from "zx"

import {
  ExitCode as CommonExitCode,
  RepoRoot,
  isEntryScript,
  parseArguments,
  usageError,
  warn
} from "./common/cli-common.mjs"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Process exit codes (documented in the header). */
const ExitCode = Object.freeze({ ...CommonExitCode, violation: CommonExitCode.failure })

/** Flag kinds this script accepts (anything else is a usage error). */
const Flags = Object.freeze({ strings: ["repo-path"] })

/** The workspace directory holding every package. */
const PackagesDirectory = "packages"

/** Root files allowed in every package. */
const AllowedFilePatterns = Object.freeze([
  /^package\.json$/,
  /^README\.md$/,
  /^CHANGELOG\.md$/,
  /^LICENSE$/,
  /^\.gitignore$/,
  /^\.npmignore$/,
  /^tsconfig(\.[\w-]+)*\.json$/,
  /^jest\.config\.(ts|js|cjs|mjs)$/,
  /^(webpack|esbuild)\.config\.(ts|mts|js|mjs|cjs)$/
])

/** Root directories allowed in every package. */
const AllowedDirectories = Object.freeze(["src", "tests", "bin", "scripts", "etc", "resources", "lib", "dist"])

/** The browser-extension manifest file name. */
const ExtensionManifestFilename = "manifest.json"

/** Key that marks a manifest.json as a WebExtension manifest. */
const ExtensionManifestVersionKey = "manifest_version"

/** Extra root entries a browser-extension package may keep (store tooling expects them there). */
const ExtensionRootEntries = Object.freeze([ExtensionManifestFilename, "icons"])

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Whether a package is a browser extension (its root manifest.json is a WebExtension manifest).
 *
 * @param {string} packagePath the package directory.
 * @return {boolean} true for a browser-extension package.
 */
function isBrowserExtension(packagePath) {
  const manifestFile = path.join(packagePath, ExtensionManifestFilename)
  if (!fs.existsSync(manifestFile)) return false
  try {
    const manifest = fs.readJsonSync(manifestFile)
    return manifest != null && typeof manifest === "object" && Object.hasOwn(manifest, ExtensionManifestVersionKey)
  } catch (error) {
    warn(`package layout: ${manifestFile} is not valid JSON (${error.message}) — not treated as an extension manifest`)
    return false
  }
}

/**
 * Whether one root entry is allowed.
 *
 * @param {string} entry the root entry name.
 * @param {boolean} isDirectory whether it is a directory.
 * @param {boolean} browserExtension whether the package is a browser extension.
 * @return {boolean} true when the standard allows it.
 */
function isAllowedRootEntry(entry, isDirectory, browserExtension) {
  return (
    (browserExtension && ExtensionRootEntries.includes(entry)) ||
    (isDirectory ? AllowedDirectories.includes(entry) : AllowedFilePatterns.some(pattern => pattern.test(entry)))
  )
}

/**
 * Every root entry outside the standard, as `packages/<name>/<entry>` paths.
 *
 * @param {string} repoPath the repository root.
 * @param {string[]} files repository-relative file paths (tracked or trackable).
 * @return {string[]} the offending root entries, sorted and unique.
 */
function findViolations(repoPath, files) {
  const rootEntries = files
      .map(file => file.split("/"))
      .filter(segments => segments[0] === PackagesDirectory && segments.length >= 3)
      .map(segments => ({ name: segments[1], entry: segments[2], isDirectory: segments.length > 3 })),
    browserExtensions = new Map(
      [...new Set(rootEntries.map(({ name }) => name))].map(name => [
        name,
        isBrowserExtension(path.join(repoPath, PackagesDirectory, name))
      ])
    )
  return [
    ...new Set(
      rootEntries
        .filter(({ name, entry, isDirectory }) => !isAllowedRootEntry(entry, isDirectory, browserExtensions.get(name)))
        .map(({ name, entry, isDirectory }) => `${PackagesDirectory}/${name}/${entry}${isDirectory ? "/" : ""}`)
    )
  ].sort()
}

/**
 * Repository-relative paths git tracks or would track (ignored output excluded).
 *
 * @param {string} repoPath the repository root.
 * @return {Promise<string[]>} the paths.
 */
async function listRepositoryFiles(repoPath) {
  const result = await $({ cwd: repoPath, nothrow: true })`git ls-files -co --exclude-standard -- ${PackagesDirectory}`
  if (result.exitCode !== ExitCode.success) usageError(`not a git repository: ${repoPath} (${result.stderr.trim()})`)
  return result.stdout.split("\n").filter(line => line.length > 0)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** Parse flags, list files, report violations. */
async function main() {
  const { "repo-path": repoPathOption = RepoRoot } = parseArguments(Flags),
    repoPath = path.resolve(repoPathOption)
  if (!fs.existsSync(path.join(repoPath, PackagesDirectory))) usageError(`no ${PackagesDirectory}/ directory under ${repoPath}`)
  const violations = findViolations(repoPath, await listRepositoryFiles(repoPath))
  if (violations.length === 0) {
    echo(`package layout: every package root in ${repoPath} is clean`)
    return ExitCode.success
  }
  echo(chalk.red(`package layout: ${violations.length} root entr${violations.length === 1 ? "y is" : "ies are"} outside the standard`))
  violations.forEach(violation => echo(chalk.red(`  ${violation}`)))
  echo("move helper scripts to scripts/<topic>/, tool configuration to etc/<tool>/, suites to tests/{node,e2e,bench}/,")
  echo("static app files to resources/, and test reports to dist/test-results/")
  return ExitCode.violation
}

if (isEntryScript(import.meta.filename)) {
  process.exitCode = await main()
}
