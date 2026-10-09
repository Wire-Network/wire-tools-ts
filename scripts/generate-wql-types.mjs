#!/usr/bin/env node
/**
 * Generate the WIRE QL TypeScript artifacts derived from wire-sysio's query engine plugin:
 *   1. the antlr-ng lexer/parser for `grammar/WireQuery.g4` → packages/ql-shared/src/grammar/generated/
 *      + packages/ql-shared/src/grammar/GRAMMAR_SOURCE.json
 *   2. committed copies of `schema/query-{request,response}.schema.json` and `examples/*.json`
 *      → packages/ql-shared/tests/fixtures/engine/ + packages/ql-shared/src/protocol/SCHEMA_SOURCE.json
 *
 * Both sets come from the same sibling wire-sysio checkout, so one script with one
 * `--wire-sysio-path` input and one `--check` mode keeps them consistent. The two drift
 * records stay separate because they guard different consumers.
 *
 * Usage:
 *   ./scripts/generate-wql-types.mjs [options]
 *
 * Options:
 *   --wire-sysio-path <dir>  wire-sysio checkout (env: WIRE_SYSIO_PATH; default: ../wire-sysio)
 *   --ql-shared-path <dir>   the @wireio/ql-shared package to write into / verify
 *                            (env: WIRE_QL_SHARED_PATH; default: packages/ql-shared)
 *   --check                  verify instead of writing (see exit codes)
 *   --grammar                only the grammar stage (default: both stages)
 *   --schemas                only the engine schema/example stage (default: both stages)
 *
 * Exit codes:
 *   0  generated, or --check passed (prints GRAMMAR-SOURCE-UNVERIFIED / SCHEMA-SOURCE-UNVERIFIED on stderr when
 *      the sibling is absent and only committed-file integrity could be proven)
 *   1  --check found GRAMMAR-DRIFT / SCHEMA-DRIFT, or committed files fail their recorded sha256
 *   2  usage error (unknown option, stray argument, valueless path option, missing input,
 *      antlr-ng not installed)
 *   3  antlr-ng failed (its output is printed)
 *
 * Examples:
 *   ./scripts/generate-wql-types.mjs
 *   ./scripts/generate-wql-types.mjs --check
 *   ./scripts/generate-wql-types.mjs --wire-sysio-path ~/code/wire-sysio --check
 *   ./scripts/generate-wql-types.mjs --grammar
 */

import { chalk, echo, fs, os, path, $ } from "zx"

import {
  ExitCode as CommonExitCode,
  RepoRoot,
  isEntryScript,
  parseArguments,
  resolvePathOption,
  sha256File,
  toolFailure,
  usageError,
  warn
} from "./common/cli-common.mjs"
import { diffFields, diffHashes, printDrift, readRecord, writeRecord } from "./common/drift-record.mjs"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Process exit codes (documented in the header). */
const ExitCode = Object.freeze({ ...CommonExitCode, drift: CommonExitCode.failure })

/** Flag kinds this script accepts (anything else is a usage error). */
const Flags = Object.freeze({ booleans: ["check", "grammar", "schemas"], strings: ["wire-sysio-path", "ql-shared-path"] })

/** Tool that generates the grammar (recorded in GRAMMAR_SOURCE.json). */
const GrammarTool = "antlr-ng"
/** antlr-ng target language. */
const GrammarLanguage = "TypeScript"
/** Engine plugin directory, relative to the wire-sysio root. */
const PluginSubpath = path.join("plugins", "query_engine_plugin")
/** Grammar file, relative to the wire-sysio root (also the recorded `grammarFile`). */
const GrammarSubpath = path.join(PluginSubpath, "grammar", "WireQuery.g4")
/** Engine schema directory, relative to the wire-sysio root. */
const SchemaSubpath = path.join(PluginSubpath, "schema")
/** Engine examples directory, relative to the wire-sysio root. */
const ExamplesSubpath = path.join(PluginSubpath, "examples")
/** Request schema filename. */
const RequestSchemaFilename = "query-request.schema.json"
/** Response schema filename. */
const ResponseSchemaFilename = "query-response.schema.json"
/** Generated grammar output, relative to the ql-shared package. */
const GrammarOutputSubpath = path.join("src", "grammar", "generated")
/** Grammar drift record, relative to the ql-shared package. */
const GrammarSourceSubpath = path.join("src", "grammar", "GRAMMAR_SOURCE.json")
/** Schema drift record, relative to the ql-shared package. */
const SchemaSourceSubpath = path.join("src", "protocol", "SCHEMA_SOURCE.json")
/** Committed engine fixtures, relative to the ql-shared package. */
const EngineFixturesSubpath = path.join("tests", "fixtures", "engine")
/** Only these antlr-ng outputs are committed (`.interp` / `.tokens` are not runtime inputs). */
const GeneratedExtension = ".ts"
/** Extension of the engine schema and example files. */
const JsonExtension = ".json"
/** Engine fixture subdirectory holding the schema copies. */
const FixtureSchemaDirectory = "schema"
/** Engine fixture subdirectory holding the example copies. */
const FixtureExamplesDirectory = "examples"
/** The usage error when the grammar tool is missing. */
const GrammarToolMissingMessage = `${GrammarTool} is not installed — run pnpm install`
/** The SCHEMA_SOURCE.json fields holding the two schema digests. */
const SchemaDigestFields = Object.freeze(["requestSchemaSha256", "responseSchemaSha256"])
/** The GRAMMAR_SOURCE.json fields compared against the sibling grammar beyond its output hashes. */
const GrammarInputFields = Object.freeze(["grammarSha256", "toolVersion"])

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** The antlr-ng executable installed at the repo root. */
const antlrBin = path.join(RepoRoot, "node_modules", ".bin", GrammarTool)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * List the `.json` files of a directory (sorted).
 *
 * @param {string} dir the directory.
 * @return {string[]} file names.
 */
function listJson(dir) {
  return fs
    .readdirSync(dir)
    .filter(name => name.endsWith(JsonExtension))
    .sort()
}

/**
 * Hash every file a directory holds (non-recursive), filtered by extension.
 *
 * @param {string} dir the directory (missing → empty map).
 * @param {string} extension suffix to keep.
 * @return {Record<string,string>} name → sha256.
 */
function hashDirectory(dir, extension) {
  if (!fs.existsSync(dir)) return {}
  return Object.fromEntries(
    fs
      .readdirSync(dir)
      .filter(name => name.endsWith(extension))
      .sort()
      .map(name => [name, sha256File(path.join(dir, name))])
  )
}

// ---------------------------------------------------------------------------
// Grammar stage
// ---------------------------------------------------------------------------

/**
 * Version of the installed antlr-ng (recorded so a tool bump is detectable drift).
 *
 * @return {string} the version.
 */
function antlrVersion() {
  const packageFile = path.join(RepoRoot, "node_modules", GrammarTool, "package.json")
  if (!fs.existsSync(packageFile)) usageError(GrammarToolMissingMessage)
  return fs.readJsonSync(packageFile).version
}

/**
 * Run antlr-ng on the sibling grammar into `outDir`, keeping only the `.ts` outputs.
 *
 * @param {string} grammarFile absolute path of WireQuery.g4.
 * @param {string} outDir destination directory (emptied first).
 */
async function generateGrammar(grammarFile, outDir) {
  if (!fs.existsSync(antlrBin)) usageError(GrammarToolMissingMessage)
  fs.emptyDirSync(outDir)
  const result = await $({ nothrow: true })`${antlrBin} -Dlanguage=${GrammarLanguage} --generate-visitor -o ${outDir} ${grammarFile}`
  if (result.exitCode !== ExitCode.success) {
    echo(result.stdout)
    warn(result.stderr)
    toolFailure(`${GrammarTool} failed (exit ${result.exitCode ?? result.signal})`)
  }
  fs.readdirSync(outDir)
    .filter(name => !name.endsWith(GeneratedExtension))
    .forEach(name => fs.removeSync(path.join(outDir, name)))
}

/**
 * Build the GRAMMAR_SOURCE.json record for a generated directory.
 *
 * @param {string} grammarFile absolute path of WireQuery.g4.
 * @param {string} outDir the generated directory.
 * @return {object} the record.
 */
function grammarRecord(grammarFile, outDir) {
  return {
    grammarFile: GrammarSubpath.split(path.sep).join("/"),
    grammarSha256: sha256File(grammarFile),
    tool: GrammarTool,
    toolVersion: antlrVersion(),
    generatedSha256: hashDirectory(outDir, GeneratedExtension)
  }
}

/**
 * Grammar stage: generate, or --check.
 *
 * @param {object} context resolved paths + mode.
 * @return {Promise<number>} the stage's exit code.
 */
async function grammarStage({ wireSysio, qlShared, check }) {
  const grammarFile = path.join(wireSysio, GrammarSubpath),
    committedDir = path.join(qlShared, GrammarOutputSubpath),
    recordFile = path.join(qlShared, GrammarSourceSubpath),
    siblingPresent = fs.existsSync(grammarFile)

  if (!check) {
    if (!siblingPresent) usageError(`grammar not found at ${grammarFile}`)
    await generateGrammar(grammarFile, committedDir)
    writeRecord(recordFile, grammarRecord(grammarFile, committedDir))
    echo(chalk.green(`grammar: generated ${committedDir}`))
    return ExitCode.success
  }

  const recorded = readRecord(recordFile)
  if (recorded == null) {
    printDrift(`GRAMMAR-DRIFT: ${recordFile} is missing`)
    return ExitCode.drift
  }
  const integrity = diffHashes(
    recorded.generatedSha256,
    hashDirectory(committedDir, GeneratedExtension)
  )
  if (integrity.length > 0) {
    printDrift(`GRAMMAR-DRIFT: committed generated files do not match ${recordFile}`, integrity)
    return ExitCode.drift
  }
  if (!siblingPresent) {
    warn(`GRAMMAR-SOURCE-UNVERIFIED: sibling wire-sysio not found at ${wireSysio}`)
    return ExitCode.success
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wql-grammar-"))
  try {
    await generateGrammar(grammarFile, tempDir)
    const fresh = grammarRecord(grammarFile, tempDir),
      differences = [
        ...diffFields(recorded, fresh, GrammarInputFields),
        ...diffHashes(recorded.generatedSha256, fresh.generatedSha256)
      ]
    if (differences.length > 0) {
      printDrift("GRAMMAR-DRIFT: regenerate with ./scripts/generate-wql-types.mjs --grammar", differences)
      return ExitCode.drift
    }
    echo(chalk.green("grammar: in sync with the sibling wire-sysio"))
    return ExitCode.success
  } finally {
    fs.removeSync(tempDir)
  }
}

// ---------------------------------------------------------------------------
// Schema stage
// ---------------------------------------------------------------------------

/**
 * Hash the schema + example files of an engine-shaped directory pair.
 *
 * @param {string} schemaDir directory holding the two schema files.
 * @param {string} examplesDir directory holding the example JSON files.
 * @return {object} the SCHEMA_SOURCE.json record.
 */
function schemaRecord(schemaDir, examplesDir) {
  const hashOrNull = file => (fs.existsSync(file) ? sha256File(file) : null)
  return {
    requestSchemaSha256: hashOrNull(path.join(schemaDir, RequestSchemaFilename)),
    responseSchemaSha256: hashOrNull(path.join(schemaDir, ResponseSchemaFilename)),
    examples: hashDirectory(examplesDir, JsonExtension)
  }
}

/**
 * Compare two SCHEMA_SOURCE records.
 *
 * @param {object} expected recorded.
 * @param {object} actual recomputed.
 * @return {string[]} differences.
 */
function diffSchemaRecords(expected, actual) {
  return [
    ...diffFields(expected, actual, SchemaDigestFields),
    ...diffHashes(expected.examples, actual.examples).map(line => `examples/${line}`)
  ]
}

/**
 * Copy the sibling's schemas + examples into the committed fixture directory.
 *
 * @param {string} wireSysio wire-sysio root.
 * @param {string} fixturesDir destination (`tests/fixtures/engine`).
 */
function copyEngineSchemas(wireSysio, fixturesDir) {
  const schemaOut = path.join(fixturesDir, FixtureSchemaDirectory),
    examplesOut = path.join(fixturesDir, FixtureExamplesDirectory),
    schemaIn = path.join(wireSysio, SchemaSubpath),
    examplesIn = path.join(wireSysio, ExamplesSubpath)
  fs.emptyDirSync(schemaOut)
  fs.emptyDirSync(examplesOut)
  ;[RequestSchemaFilename, ResponseSchemaFilename].forEach(name =>
    fs.copyFileSync(path.join(schemaIn, name), path.join(schemaOut, name))
  )
  listJson(examplesIn).forEach(name =>
    fs.copyFileSync(path.join(examplesIn, name), path.join(examplesOut, name))
  )
}

/**
 * Schema stage: copy, or --check.
 *
 * @param {object} context resolved paths + mode.
 * @return {number} the stage's exit code.
 */
function schemaStage({ wireSysio, qlShared, check }) {
  const schemaIn = path.join(wireSysio, SchemaSubpath),
    examplesIn = path.join(wireSysio, ExamplesSubpath),
    fixturesDir = path.join(qlShared, EngineFixturesSubpath),
    recordFile = path.join(qlShared, SchemaSourceSubpath),
    siblingPresent =
      fs.existsSync(path.join(schemaIn, RequestSchemaFilename)) &&
      fs.existsSync(path.join(schemaIn, ResponseSchemaFilename)) &&
      fs.existsSync(examplesIn)

  if (!check) {
    if (!siblingPresent) usageError(`engine schemas not found under ${schemaIn}`)
    copyEngineSchemas(wireSysio, fixturesDir)
    writeRecord(recordFile, schemaRecord(schemaIn, examplesIn))
    echo(chalk.green(`schemas: copied into ${fixturesDir}`))
    return ExitCode.success
  }

  const recorded = readRecord(recordFile)
  if (recorded == null) {
    printDrift(`SCHEMA-DRIFT: ${recordFile} is missing`)
    return ExitCode.drift
  }
  const integrity = diffSchemaRecords(
    recorded,
    schemaRecord(path.join(fixturesDir, FixtureSchemaDirectory), path.join(fixturesDir, FixtureExamplesDirectory))
  )
  if (integrity.length > 0) {
    printDrift(`SCHEMA-DRIFT: committed engine fixtures do not match ${recordFile}`, integrity)
    return ExitCode.drift
  }
  if (!siblingPresent) {
    warn(`SCHEMA-SOURCE-UNVERIFIED: sibling wire-sysio not found at ${wireSysio}`)
    return ExitCode.success
  }
  const differences = diffSchemaRecords(recorded, schemaRecord(schemaIn, examplesIn))
  if (differences.length > 0) {
    printDrift("SCHEMA-DRIFT: re-copy with ./scripts/generate-wql-types.mjs --schemas", differences)
    return ExitCode.drift
  }
  echo(chalk.green("schemas: in sync with the sibling wire-sysio"))
  return ExitCode.success
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Resolve and validate the CLI arguments.
 *
 * @return {object} `{ wireSysio, qlShared, check, stages }`.
 */
function resolveArguments() {
  const flags = parseArguments(Flags),
    wireSysio = resolvePathOption(flags, "wire-sysio-path", "WIRE_SYSIO_PATH", path.join(RepoRoot, "..", "wire-sysio")),
    qlShared = resolvePathOption(flags, "ql-shared-path", "WIRE_QL_SHARED_PATH", path.join(RepoRoot, "packages", "ql-shared")),
    { check, grammar: onlyGrammar, schemas: onlySchemas } = flags,
    stages = {
      grammar: onlyGrammar || !onlySchemas,
      schemas: onlySchemas || !onlyGrammar
    }
  if (!fs.existsSync(qlShared)) usageError(`ql-shared package not found at ${qlShared}`)
  return { wireSysio, qlShared, check, stages }
}

/**
 * Run the selected stages; the worst stage exit code wins.
 *
 * @return {Promise<number>} exit code.
 */
async function main() {
  const context = resolveArguments(),
    grammarExit = context.stages.grammar ? await grammarStage(context) : ExitCode.success,
    schemaExit = context.stages.schemas ? schemaStage(context) : ExitCode.success
  return Math.max(grammarExit, schemaExit)
}

if (isEntryScript(import.meta.filename)) {
  process.exitCode = await main()
}
