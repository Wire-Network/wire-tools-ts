/**
 * Drift records shared by the generator scripts (`generate-*.mjs`): a committed JSON file that
 * records the inputs and output digests a generated artifact set was produced from, so a
 * `--check` run can prove the committed files still match their recorded source.
 *
 * Not executable itself; scripts import it as `./common/drift-record.mjs`.
 */

import { chalk, echo, fs, path } from "zx"

/** JSON indent of every drift record (changing it rewrites every committed record). */
export const JsonIndent = 2

/** Placeholder printed for a value one side of a comparison does not have. */
const AbsentValue = "<absent>"

/**
 * Write a drift record as pretty JSON with a trailing newline (parent directories created).
 *
 * @param {string} file destination.
 * @param {object} record the record.
 */
export function writeRecord(file, record) {
  fs.mkdirpSync(path.dirname(file))
  fs.writeFileSync(file, `${JSON.stringify(record, null, JsonIndent)}\n`)
}

/**
 * Read a drift record, or null when it does not exist.
 *
 * @param {string} file the record file.
 * @return {object|null} the parsed record.
 */
export function readRecord(file) {
  return fs.existsSync(file) ? fs.readJsonSync(file) : null
}

/**
 * Format one compared value: strings verbatim, absent values as `<absent>`, anything else as JSON.
 *
 * @param {unknown} value the value.
 * @return {string} its display form.
 */
function formatValue(value) {
  if (value == null) return AbsentValue
  return typeof value === "string" ? value : JSON.stringify(value)
}

/**
 * One `"<name>: recorded X, found Y"` line per named field whose values differ.
 *
 * @param {Record<string, unknown>|null|undefined} recorded the recorded values.
 * @param {Record<string, unknown>|null|undefined} found the recomputed values.
 * @param {readonly string[]} names the fields to compare.
 * @return {string[]} one line per difference (empty when equal).
 */
export function diffFields(recorded, found, names) {
  return names.flatMap(name =>
    JSON.stringify(recorded?.[name]) === JSON.stringify(found?.[name])
      ? []
      : [`${name}: recorded ${formatValue(recorded?.[name])}, found ${formatValue(found?.[name])}`]
  )
}

/**
 * Compare two `{ name: sha256 }` maps over the union of their names (sorted).
 *
 * @param {Record<string,string>|null|undefined} recorded recorded hashes.
 * @param {Record<string,string>|null|undefined} found recomputed hashes.
 * @return {string[]} one line per difference (empty when equal).
 */
export function diffHashes(recorded, found) {
  return diffFields(recorded, found, [...new Set([...Object.keys(recorded ?? {}), ...Object.keys(found ?? {})])].sort())
}

/**
 * Print a drift headline followed by its indented difference lines.
 *
 * @param {string} headline the marker line (printed red).
 * @param {readonly string[]} [lines] the differences.
 */
export function printDrift(headline, lines = []) {
  echo(chalk.red(headline))
  lines.forEach(line => echo(`  ${line}`))
}
