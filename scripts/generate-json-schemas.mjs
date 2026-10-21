#!/usr/bin/env node
/**
 * Generate the committed JSON Schema documents of the @wireio/cluster-tool-shared codecs:
 *   packages/cluster-tool-shared (the BUILT lib/cjs) → <codec>.toJSONSchema()
 *   → docs/outpost/wire-opreg-bootstrap.schema.json
 *
 * The zod schema is the single source: each document is its codec's wire-side JSON Schema
 * (draft 2020-12), pretty-printed with `SchemaCodec.SerializeIndent` plus a trailing newline.
 * The script reads the BUILT package, so run `pnpm build` first. Drift is gated by the jest
 * suite (`packages/cluster-tool-shared/tests/cluster/WireOpregBootstrapDocs.test.ts`), which
 * compares the committed document against the source schema and runs this script's `--check`.
 *
 * Usage:
 *   ./scripts/generate-json-schemas.mjs [options]
 *
 * Options:
 *   --output-path <dir>  where the documents are written or compared
 *                        (env: WIRE_JSON_SCHEMA_OUTPUT_PATH; default: docs/outpost)
 *   --shared-path <dir>  the @wireio/cluster-tool-shared package
 *                        (env: WIRE_CLUSTER_TOOL_SHARED_PATH; default: packages/cluster-tool-shared)
 *   --check              compare the committed documents instead of writing them
 *
 * Exit codes:
 *   0  generated, or --check passed
 *   1  --check: a document is missing or differs ("regenerate with ./scripts/generate-json-schemas.mjs")
 *   2  usage error (unknown option, stray argument, the package is not built)
 *   3  a codec named in the schema table is not exported by the built package
 *
 * Examples:
 *   ./scripts/generate-json-schemas.mjs
 *   ./scripts/generate-json-schemas.mjs --check
 */

import { createRequire } from "node:module"
import { chalk, echo, fs, path } from "zx"

import {
  ExitCode as CommonExitCode,
  RepoRoot,
  isEntryScript,
  parseArguments,
  resolvePathOption,
  toolFailure,
  usageError
} from "./common/cli-common.mjs"
import { printDrift } from "./common/drift-record.mjs"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Process exit codes (documented in the header). */
const ExitCode = Object.freeze({ ...CommonExitCode, drift: CommonExitCode.failure })

/** Flag kinds this script accepts (anything else is a usage error). */
const Flags = Object.freeze({ booleans: ["check"], strings: ["output-path", "shared-path"] })

/** Default directory of the generated documents. */
const DefaultOutputPath = path.join(RepoRoot, "docs", "outpost")

/** Default location of the @wireio/cluster-tool-shared package. */
const DefaultSharedPath = path.join(RepoRoot, "packages", "cluster-tool-shared")

/** The built CommonJS entry, relative to the package. */
const BuiltEntrySubpath = path.join("lib", "cjs", "index.js")

/** Every generated document: the package's exported codec and the file it renders to. */
const Schemas = Object.freeze([
  Object.freeze({ codec: "WireOpregBootstrapSchemaCodec", file: "wire-opreg-bootstrap.schema.json" })
])

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Load the built @wireio/cluster-tool-shared package.
 *
 * @param {string} sharedPath the package directory.
 * @return {Record<string, any>} the package's exports.
 */
function loadShared(sharedPath) {
  const entry = path.join(sharedPath, BuiltEntrySubpath)
  if (!fs.existsSync(entry)) usageError(`${entry} not found — run pnpm build first`)
  return createRequire(import.meta.url)(entry)
}

/**
 * Render every document of {@link Schemas}.
 *
 * @param {Record<string, any>} shared the built package's exports.
 * @return {{ file: string, text: string }[]} each document's file name and text.
 */
function renderSchemas(shared) {
  return Schemas.map(({ codec, file }) => {
    if (shared[codec] == null) toolFailure(`${codec} is not exported by @wireio/cluster-tool-shared`)
    const document = shared[codec].toJSONSchema()
    return { file, text: `${JSON.stringify(document, null, shared.SchemaCodec.SerializeIndent)}\n` }
  })
}

/**
 * Write the rendered documents.
 *
 * @param {string} outputPath the output directory.
 * @param {{ file: string, text: string }[]} rendered the documents.
 * @return {number} exit code.
 */
function generate(outputPath, rendered) {
  fs.ensureDirSync(outputPath)
  rendered.forEach(({ file, text }) => fs.writeFileSync(path.join(outputPath, file), text))
  echo(chalk.green(`json-schemas: wrote ${rendered.map(({ file }) => file).join(", ")} into ${outputPath}`))
  return ExitCode.success
}

/**
 * Compare the committed documents with the rendered ones.
 *
 * @param {string} outputPath the directory holding the committed documents.
 * @param {{ file: string, text: string }[]} rendered the documents.
 * @return {number} exit code.
 */
function check(outputPath, rendered) {
  const drifted = rendered
    .filter(({ file, text }) => {
      const committed = path.join(outputPath, file)
      return !fs.existsSync(committed) || fs.readFileSync(committed, "utf8") !== text
    })
    .map(({ file }) => `${file}: missing or different`)
  if (drifted.length > 0) {
    printDrift("SCHEMA-DRIFT: regenerate with ./scripts/generate-json-schemas.mjs", drifted)
    return ExitCode.drift
  }
  echo(chalk.green(`json-schemas: ${rendered.length} document(s) in sync with the source schemas`))
  return ExitCode.success
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Parse the arguments, then generate or check.
 *
 * @return {number} exit code.
 */
function main() {
  const flags = parseArguments(Flags),
    outputPath = resolvePathOption(flags, "output-path", "WIRE_JSON_SCHEMA_OUTPUT_PATH", DefaultOutputPath),
    sharedPath = resolvePathOption(flags, "shared-path", "WIRE_CLUSTER_TOOL_SHARED_PATH", DefaultSharedPath),
    rendered = renderSchemas(loadShared(sharedPath))
  return flags.check ? check(outputPath, rendered) : generate(outputPath, rendered)
}

if (isEntryScript(import.meta.filename)) {
  process.exitCode = main()
}
