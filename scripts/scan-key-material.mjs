#!/usr/bin/env node
/**
 * Scan a directory tree for plaintext key material.
 *
 * The blocking pre-upload gate the cluster release workflow runs against each
 * EXTRACTED archive. It loads the ONE shared pattern set
 * (`@wireio/cluster-tool-shared`'s `KeyMaterialPatterns`) instead of re-spelling
 * the signatures, so this scan and the jest gate asserting the same property can
 * never drift apart.
 *
 * Usage:
 *   ./scripts/scan-key-material.mjs [--ignore <relative-path>]... [--patterns <set>] <dir> [<dir>...]
 *
 * Options:
 *   --ignore <path>   Skip a subtree, RELATIVE to each scan root. Repeatable.
 *   --patterns <set>  Signature set: `artifacts` (default — every persisted
 *                     secret shape) or `key-specs` (LOGS: only an unredacted
 *                     `KEY:<private>` spec). Use `key-specs` on free-form logs,
 *                     where a 32-byte hex value is a block hash far more often
 *                     than a key and the artifact set reports ~1000 non-secrets.
 *                     For the LOCAL-CHAIN artifacts (anvil state, the solana
 *                     ledger, the ethereum deployment records): they hold
 *                     well-known dev-account keys that are public by
 *                     construction and exist ONLY in a local-mode cluster. EVERY
 *                     real deployment — mainnet AND an interconnected testnet —
 *                     excludes outposts, so it runs no anvil and no
 *                     solana-test-validator and those paths are absent: the
 *                     ignore is inert in exactly the cases where the security
 *                     posture matters. Every ignored path is PRINTED, never
 *                     silently dropped.
 *
 * Exit codes:
 *   0   clean — no key material found
 *   1   key material found; each hit printed as `<file>: <signature>`
 *   2   usage error
 *
 * Examples:
 *   ./scripts/scan-key-material.mjs ./extracted
 *   ./scripts/scan-key-material.mjs --ignore data/anvil --ignore data/solana-ledger ./local ./external
 */
import { createRequire } from "node:module"
import { argv, chalk, echo, fs, path } from "zx"

/**
 * Read window. A cluster tree holds multi-GB block logs and rocksdb files, and
 * reading one as a utf8 string throws ERR_STRING_TOO_LONG past ~512MB — so the
 * scan is CHUNKED. Skipping large files instead would be a vacuous pass: the
 * gate would report "clean" precisely where the biggest artifacts are.
 */
const ChunkBytes = 8 * 1024 * 1024
/**
 * Carried across chunk boundaries so a signature straddling one is still
 * matched. Comfortably longer than the longest (a 24-word BIP-39 phrase).
 */
const OverlapBytes = 4096
/**
 * A NUL byte marks a binary blob — the same heuristic git uses.
 *
 * Written as an ESCAPE, never a literal: a literal NUL makes git classify
 * this whole file as BINARY, so the repo’s only automated barrier against
 * publishing a key-bearing release asset renders as "Binary file not shown"
 * in every PR — unreviewable, and unmergeable on conflict.
 */
const NulByte = "\u0000"

const require = createRequire(import.meta.url)
const sharedFile = path.resolve(
  import.meta.dirname,
  "..",
  "packages",
  "cluster-tool-shared",
  "lib",
  "cjs",
  "index.js"
)

if (!fs.existsSync(sharedFile)) {
  echo(chalk.red(`cluster-tool-shared build not found at ${sharedFile} — run pnpm build.`))
  process.exit(2)
}
const { findKeyMaterial, KeyMaterialPatterns, KeySpecPatterns } =
  require(sharedFile)

/** The signature set named by `--patterns` (default: the artifact set). */
const PatternSets = { artifacts: KeyMaterialPatterns, "key-specs": KeySpecPatterns }

/** Every file under `dir`, depth-first. Symlinks are NOT followed. */
function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.isFile()) yield full
  }
}

/**
 * The distinct key-material signature names present in `file`.
 *
 * @param {string} file - Absolute path of the file to scan.
 * @returns {Set<string>} Matching signature names; empty means no secret.
 */
function scanFile(file) {
  const size = fs.statSync(file).size
  const found = new Set()
  if (size === 0) return found
  const buffer = Buffer.alloc(Math.min(ChunkBytes, size))
  const fd = fs.openSync(file, "r")
  try {
    let carry = ""
    let position = 0
    let first = true
    while (position < size) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, position)
      if (read <= 0) break
      const chunk = buffer.subarray(0, read).toString("utf8")
      // A NUL in the LEADING chunk means binary: it cannot carry a
      // text-encoded key, and decoding it yields only mojibake.
      if (first && chunk.includes(NulByte)) return found
      first = false
      for (const pattern of findKeyMaterial(carry + chunk, patterns))
        found.add(pattern.name)
      carry = chunk.slice(-OverlapBytes)
      position += read
    }
  } finally {
    fs.closeSync(fd)
  }
  return found
}

const patternSetName = String(argv.patterns ?? "artifacts")
const patterns = PatternSets[patternSetName]
if (patterns == null) {
  echo(chalk.red(`scan-key-material: unknown --patterns '${patternSetName}' (expected: ${Object.keys(PatternSets).join(" | ")})`))
  process.exit(2)
}
const ignores = [argv.ignore ?? []].flat().filter(value => typeof value === "string")
const roots = argv._.map(String)

if (roots.length === 0) {
  echo(chalk.red("usage: scan-key-material.mjs [--ignore <path>]... [--patterns artifacts|key-specs] <dir> [<dir>...]"))
  process.exit(2)
}

let hits = 0
for (const root of roots) {
  if (!fs.existsSync(root)) {
    echo(chalk.red(`scan target not found: ${root}`))
    process.exit(2)
  }
  const skipped = ignores
    .map(ignore => path.resolve(root, ignore))
    .filter(full => fs.existsSync(full))
  skipped.forEach(full => echo(chalk.yellow(`IGNORING ${full}`)))
  const stat = fs.statSync(root)
  for (const file of stat.isDirectory() ? walk(root) : [root]) {
    if (skipped.some(full => file === full || file.startsWith(`${full}${path.sep}`))) continue
    for (const name of scanFile(file)) {
      echo(`${file}: ${name}`)
      hits += 1
    }
  }
}

echo(
  hits === 0
    ? chalk.green(`scan-key-material: clean — no key material in ${roots.join(", ")}`)
    : chalk.red(`scan-key-material: ${hits} key-material hit(s) — REFUSING`)
)
process.exit(hits === 0 ? 0 : 1)
