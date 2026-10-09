/**
 * Helpers shared by the repository's executable scripts (`scripts/*.mjs`): the repository root,
 * the common exit codes, stderr messages (warnings, usage errors, tool failures), argument
 * parsing with declared flag kinds, path options with an environment fallback, sha256 digests,
 * and the entry-script guard.
 *
 * Not executable itself; scripts import it as `./common/cli-common.mjs`.
 */

import { createHash } from "node:crypto"
import { chalk, fs, minimist, path } from "zx"

/** The wire-tools-ts repository root (one level above `scripts/`). */
export const RepoRoot = path.resolve(import.meta.dirname, "..", "..")

/**
 * Process exit codes shared by every script (each script header documents what they mean for
 * it; scripts alias `failure` to their own meaning — drift, a layout violation, a failed stage).
 *
 * - `success` (0): the script did its job / the check passed.
 * - `failure` (1): the check found a problem (drift, violation, failed stage).
 * - `usage` (2): bad arguments, a missing input, or a dependency that is not installed.
 * - `toolFailure` (3): an external tool or renderer the script drives failed.
 */
export const ExitCode = Object.freeze({ success: 0, failure: 1, usage: 2, toolFailure: 3 })

/** The literal values a boolean flag may carry in `--flag=<value>` form. */
const BooleanFlagValues = Object.freeze(["true", "false"])

/** The minimist key holding positional arguments. */
const PositionalKey = "_"

/** Prefix of a long flag. */
const LongFlagPrefix = "--"

/** Separator between a long flag and its inline value. */
const InlineValueSeparator = "="

/** Arguments after this token are positional. */
const EndOfOptions = "--"

/**
 * Print a warning line on stderr.
 *
 * @param {string} message the warning.
 */
export function warn(message) {
  process.stderr.write(`${message}\n`)
}

/**
 * Print a usage error on stderr and exit with {@link ExitCode}.usage.
 *
 * @param {string} message what was wrong.
 */
export function usageError(message) {
  warn(chalk.red(`Error: ${message}`))
  process.exit(ExitCode.usage)
}

/**
 * Print a tool failure on stderr — the message, then the cause's stack — and exit with
 * {@link ExitCode}.toolFailure.
 *
 * @param {string} message what failed.
 * @param {unknown} [cause] the caught error (its stack is printed in full).
 */
export function toolFailure(message, cause) {
  warn(chalk.red(`Error: ${message}`))
  if (cause != null) warn(cause instanceof Error ? (cause.stack ?? cause.message) : String(cause))
  process.exit(ExitCode.toolFailure)
}

/**
 * Reject a boolean flag given an inline non-boolean value (`--check=extra`) — minimist would
 * otherwise read it as `true`.
 *
 * @param {readonly string[]} args the raw arguments.
 * @param {readonly string[]} booleans the boolean flag names.
 */
function assertBooleanInlineValues(args, booleans) {
  const endOfOptions = args.indexOf(EndOfOptions)
  ;(endOfOptions < 0 ? args : args.slice(0, endOfOptions))
    .filter(arg => arg.startsWith(LongFlagPrefix) && arg.includes(InlineValueSeparator))
    .map(arg => arg.slice(LongFlagPrefix.length).split(InlineValueSeparator))
    .filter(([name]) => booleans.includes(name))
    .forEach(([name, ...value]) => {
      const text = value.join(InlineValueSeparator)
      if (!BooleanFlagValues.includes(text)) usageError(`--${name} takes no value (got "${text}")`)
    })
}

/**
 * Parse the command line against the declared flag kinds and reject everything else: unknown
 * flags, positional arguments, a boolean flag with a non-boolean value (`--check extra`,
 * `--check=extra`), and a string flag without exactly one non-empty value (`--repo-path` with
 * nothing after it, or given twice). Every violation is a usage error.
 *
 * @param {object} [kinds]
 * @param {readonly string[]} [kinds.booleans] boolean flags (without `--`).
 * @param {readonly string[]} [kinds.strings] string-valued flags (without `--`).
 * @param {readonly string[]} [args] the arguments (default: `process.argv.slice(2)`).
 * @return {Record<string, boolean|string|undefined>} flag name → value (booleans default false,
 *   absent strings are undefined).
 */
export function parseArguments({ booleans = [], strings = [] } = {}, args = process.argv.slice(2)) {
  assertBooleanInlineValues(args, booleans)
  const { [PositionalKey]: positionals, ...flags } = minimist([...args], {
      boolean: [...booleans],
      string: [...strings]
    }),
    unknown = Object.keys(flags).filter(flag => !booleans.includes(flag) && !strings.includes(flag))
  if (unknown.length > 0) usageError(`unknown option(s): ${unknown.map(flag => `--${flag}`).join(", ")}`)
  if (positionals.length > 0) usageError(`unexpected argument(s): ${positionals.join(" ")}`)
  strings
    .filter(flag => flag in flags)
    .forEach(flag => {
      if (Array.isArray(flags[flag])) usageError(`--${flag} given more than once`)
      if (flags[flag].length === 0) usageError(`--${flag} requires a value`)
    })
  return flags
}

/**
 * Resolve a path option: `--<flag>`, else the environment variable, else the default.
 *
 * @param {Record<string, boolean|string|undefined>} flags the result of {@link parseArguments}.
 * @param {string} flag the option name (without `--`).
 * @param {string} environmentVariable the fallback variable.
 * @param {string} defaultPath the default path.
 * @return {string} the absolute path.
 */
export function resolvePathOption(flags, flag, environmentVariable, defaultPath) {
  const value = flags[flag] ?? process.env[environmentVariable] ?? defaultPath
  if (typeof value !== "string" || value.length === 0) usageError(`--${flag} requires a path`)
  return path.resolve(value)
}

/**
 * sha256 hex digest of bytes.
 *
 * @param {Buffer|string} bytes the input.
 * @return {string} lowercase hex digest.
 */
export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

/**
 * sha256 hex digest of a file's bytes.
 *
 * @param {string} file the file.
 * @return {string} lowercase hex digest.
 */
export function sha256File(file) {
  return sha256(fs.readFileSync(file))
}

/**
 * Whether the importer is the process entry script (so `main` runs only when executed, not when
 * a test imports it). The invoked path is resolved through symlinks, matching the real path
 * Node gives `import.meta.filename`.
 *
 * @param {string} filename the importer's `import.meta.filename`.
 * @return {boolean} true when executed directly.
 */
export function isEntryScript(filename) {
  const invoked = process.argv[1]
  return invoked != null && fs.existsSync(invoked) && fs.realpathSync(invoked) === fs.realpathSync(filename)
}
