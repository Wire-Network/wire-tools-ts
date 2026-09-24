#!/usr/bin/env node
/**
 * Update every `@wireio/*` dependency in this monorepo to its own latest
 * version on npm.
 *
 * Scope: EVERY `@wireio/*` package the repo declares — regardless of which
 * repo publishes it (wire-libraries-ts, wire-sysio's opp model bundles, the
 * outpost artifact packages, ...). Each dependency updates to ITS OWN
 * `latest` dist-tag; versions are never cross-assigned between packages.
 * `workspace:*` dependencies (this repo's own packages) are never touched.
 *
 * Coverage: every package.json outside node_modules / lib / dist / .git
 * (root + workspace packages), across `dependencies`, `devDependencies`,
 * and `resolutions`. Each declaration keeps its OWN range operator — only
 * the version number moves. Complex ranges (anything but `^x.y.z` /
 * `~x.y.z` / `x.y.z`) are skipped with a warning rather than guessed at.
 *
 * Branch- and environment-agnostic: the script operates on the WORKING TREE
 * wherever it is invoked — by hand on any branch, or inside GHA — and WRITES
 * the updates by default. `--dry-run` is the single no-write mode; it still
 * prints what would change, in one of two formats (human-readable by default,
 * one JSON document with `--json`).
 *
 * Usage:
 *   ./scripts/update-wireio-deps.mjs [options]
 *
 * Options:
 *   --dry-run                Preview only — print what would change without
 *                            writing any file; exits 2 when updates exist
 *                            (a script-friendly drift signal)
 *   --json                   Machine-readable output: stdout carries ONE JSON
 *                            document ({ dryRun, editCount, updated, edits,
 *                            complexSkips, registrySkips }) instead of the
 *                            human-readable report
 *   --report-file <path>     Write the markdown update report (PR-body fragment)
 *   --summary-file <path>    Write `{ "updated": { name: latest }, "editCount": n }`
 *                            as JSON (the workflow derives the branch name from it)
 *
 * Examples:
 *   ./scripts/update-wireio-deps.mjs                 # update the working tree
 *   ./scripts/update-wireio-deps.mjs --dry-run       # human-readable preview
 *   ./scripts/update-wireio-deps.mjs --dry-run --json | jq .updated
 *   ./scripts/update-wireio-deps.mjs \
 *       --report-file update-output/report.md --summary-file update-output/summary.json
 *
 * Exit codes:
 *   0  updates written, or already current (no-op)
 *   1  error (registry failure, no @wireio/* dependencies declared, bad input)
 *   2  --dry-run found at least one available update
 */

import { fileURLToPath } from "node:url"
import { argv, chalk, echo, fs, glob, path, $ } from "zx"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
/** Repo root = one level up from scripts/ (the same file serves both repos). */
const repoRoot = path.resolve(scriptDir, "..")

/** Scope prefix every update candidate carries. */
const WireScope = "@wireio/"
/** Dependency value prefix marking this repo's own workspace packages. */
const WorkspaceProtocolPrefix = "workspace:"
/**
 * package.json sections that may carry update candidates. `resolutions`
 * covers the root policy-pin block (no `@wireio/*` entries exist there today;
 * this future-proofs the field).
 */
const DependencyFields = ["dependencies", "devDependencies", "resolutions"]
/**
 * The only range shapes this script rewrites: an optional `^` or `~` followed
 * by a stable x.y.z. Group 1 is the preserved OPERATOR, group 2 the version.
 */
const SimpleRangePattern = /^([\^~]?)(\d+\.\d+\.\d+)$/
/** Stable x.y.z shape a `latest` dist-tag must have to be applied. */
const StableVersionPattern = /^\d+\.\d+\.\d+$/
/** Manifest discovery glob and the trees it must never descend into. */
const ManifestGlob = "**/package.json"
const ManifestIgnoreGlobs = ["**/node_modules/**", "**/lib/**", "**/dist/**", "**/.git/**"]
/** Indentation for rewritten package.json files (repo standard). */
const ManifestJsonSpaces = 2

// ---------------------------------------------------------------------------
// Manifest discovery
// ---------------------------------------------------------------------------

/**
 * Discover every manifest that can declare `@wireio/*` dependencies —
 * dynamically, so new workspace packages (and repos with different layouts,
 * e.g. an `examples/*` glob) are covered with no list to maintain.
 *
 * @return {Promise<Array<{ file: string, json: object }>>} loaded manifests
 */
async function discoverManifests() {
  const files = await glob(ManifestGlob, {
    cwd: repoRoot,
    ignore: ManifestIgnoreGlobs,
    absolute: true
  })
  return Promise.all(files.sort().map(async file => ({ file, json: await fs.readJson(file) })))
}

/**
 * Collect the distinct `@wireio/*` dependency names declared across the given
 * manifests, excluding `workspace:*` values (this repo's own packages).
 *
 * @param {Array<{ file: string, json: object }>} manifests loaded manifests
 * @return {string[]} sorted candidate package names
 */
function collectCandidateNames(manifests) {
  const names = new Set()
  manifests.forEach(({ json }) =>
    DependencyFields.forEach(field =>
      Object.entries(json[field] ?? {}).forEach(([name, range]) => {
        if (name.startsWith(WireScope) && !String(range).startsWith(WorkspaceProtocolPrefix)) {
          names.add(name)
        }
      })
    )
  )
  return [...names].sort()
}

// ---------------------------------------------------------------------------
// Registry resolution
// ---------------------------------------------------------------------------

/**
 * Resolve one package's `latest` dist-tag from npm.
 *
 * @param {string} name npm package name
 * @return {Promise<{ name: string, latest: string } | null>} the package name
 *   and its `latest` dist-tag — `null` when the package does not exist on the
 *   registry (E404); every other registry failure throws
 */
async function viewLatest(name) {
  // --prefer-online: the registry CDN caches packuments for up to 300 s — a
  // post-release run must not settle for a cached read.
  const result = await $`npm view ${name} --json --prefer-online version dist-tags`
    .nothrow()
    .quiet()
  if (result.exitCode !== 0) {
    if (/\bE404\b/.test(result.stderr)) {
      return null
    }
    throw new Error(`npm view ${name} failed (exit ${result.exitCode}): ${result.stderr.trim()}`)
  }
  // npm view --json wraps multi-field output in a one-element array on current
  // npm majors (verified on npm 12 / Node 24 — the workflow's pin); older
  // majors return the bare object — accept both shapes, and fail LOUDLY when
  // neither yields a version. (A silent fallback here once misclassified every
  // package in an earlier design; never default this.)
  const parsed = JSON.parse(result.stdout)
  const info = Array.isArray(parsed) ? parsed[0] : parsed
  const latest = info?.["dist-tags"]?.latest ?? info?.version
  if (latest == null) {
    throw new Error(`npm view ${name}: no version in the --json payload — registry output shape changed?`)
  }
  return { name, latest }
}

/**
 * Resolve the latest stable version for every candidate. A 404 (not on the
 * registry) and a non-stable `latest` dist-tag become skip RECORDS — the
 * caller decides how to render them (human warnings, or fields of the --json
 * document; nothing may print here or JSON stdout would be polluted).
 *
 * @param {string[]} candidateNames the locally-declared `@wireio/*` names
 * @return {Promise<{ latestVersions: Map<string, string>, registrySkips: Array<{ name: string, reason: string }> }>}
 *   the resolved package name → latest stable version map, plus the skips
 */
async function resolveLatestVersions(candidateNames) {
  const latestVersions = new Map()
  const registrySkips = []
  // Sequential on purpose: a handful of packages, and interleaved npm output
  // would garble the log.
  for (const name of candidateNames) {
    const view = await viewLatest(name)
    if (view == null) {
      registrySkips.push({ name, reason: "not published on the registry" })
      continue
    }
    if (!StableVersionPattern.test(view.latest)) {
      registrySkips.push({ name, reason: `latest dist-tag ${view.latest} is not a stable x.y.z` })
      continue
    }
    latestVersions.set(name, view.latest)
  }
  return { latestVersions, registrySkips }
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

/**
 * Rewrite the latest versions into the loaded manifests (in memory),
 * preserving each declaration's range operator; collect one edit record per
 * changed declaration and one skip record per complex range left alone.
 *
 * @param {Array<{ file: string, json: object }>} manifests loaded manifests
 * @param {Map<string, string>} latestVersions package name → latest stable version
 * @return {{ edits: Array<{ file: string, field: string, name: string, oldRange: string, newRange: string }>,
 *            complexSkips: Array<{ file: string, field: string, name: string, range: string }> }}
 *   the applied edits and the skipped complex-range declarations
 */
function updateManifests(manifests, latestVersions) {
  const edits = []
  const complexSkips = []
  manifests.forEach(({ file, json }) =>
    DependencyFields.forEach(field =>
      Object.entries(json[field] ?? {}).forEach(([name, range]) => {
        const latest = latestVersions.get(name)
        if (latest == null || String(range).startsWith(WorkspaceProtocolPrefix)) {
          return
        }
        const match = SimpleRangePattern.exec(String(range))
        if (match == null) {
          complexSkips.push({ file, field, name, range: String(range) })
          return
        }
        const [, operator] = match
        const newRange = `${operator}${latest}`
        if (range !== newRange) {
          json[field][name] = newRange
          edits.push({ file, field, name, oldRange: String(range), newRange })
        }
      })
    )
  )
  return { edits, complexSkips }
}

/**
 * Render the markdown update report — the PR-body fragment.
 *
 * @param {Array<{ name: string, oldRange: string, newRange: string }>} edits changed declarations
 * @param {Array<{ file: string, name: string, range: string }>} complexSkips complex-range declarations left alone
 * @return {string} markdown report
 */
function renderReport(edits, complexSkips) {
  const header = "## Update `@wireio/*` dependencies to latest"
  const skipLines =
    complexSkips.length === 0
      ? []
      : [
          "",
          "Left alone (complex ranges — update by hand if intended):",
          ...complexSkips.map(skip => `- \`${skip.name}\` \`${skip.range}\` in \`${path.relative(repoRoot, skip.file)}\``)
        ]
  if (edits.length === 0) {
    return [header, "", "Already current — no manifest changes.", ...skipLines, ""].join("\n")
  }
  const byName = new Map()
  edits.forEach(edit => {
    if (!byName.has(edit.name)) {
      byName.set(edit.name, { oldRanges: new Set(), newRanges: new Set(), declarationCount: 0 })
    }
    const row = byName.get(edit.name)
    row.oldRanges.add(edit.oldRange)
    row.newRanges.add(edit.newRange)
    row.declarationCount += 1
  })
  const rows = [...byName.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([name, { oldRanges, newRanges, declarationCount }]) =>
        `| \`${name}\` | ${[...oldRanges].sort().map(range => `\`${range}\``).join(", ")} | ${[...newRanges].sort().map(range => `\`${range}\``).join(", ")} | ${declarationCount} |`
    )
  return [
    header,
    "",
    "Every `@wireio/*` dependency updates to ITS OWN npm `latest`; range operators",
    "are preserved; `workspace:*` is untouched.",
    "",
    "| package | previous range(s) | updated to | declarations |",
    "|---|---|---|---|",
    ...rows,
    ...skipLines,
    ""
  ].join("\n")
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const dryRun = argv["dry-run"] === true
  const jsonOutput = argv.json === true
  const reportFile = argv["report-file"]
  const summaryFile = argv["summary-file"]

  const manifests = await discoverManifests()
  const candidateNames = collectCandidateNames(manifests)
  if (candidateNames.length === 0) {
    throw new Error("no @wireio/* dependencies declared in any manifest — nothing to update")
  }
  if (!jsonOutput) {
    echo(`candidates: ${candidateNames.join(", ")}`)
  }

  const { latestVersions, registrySkips } = await resolveLatestVersions(candidateNames)
  if (latestVersions.size === 0) {
    throw new Error("no @wireio/* candidate resolved a stable latest version from the registry")
  }
  if (!jsonOutput) {
    registrySkips.forEach(skip => echo(chalk.yellow(`skip ${skip.name} — ${skip.reason}`)))
    echo(`latest: ${[...latestVersions.entries()].map(([name, latest]) => `${name}@${latest}`).join(", ")}`)
  }

  const { edits, complexSkips } = updateManifests(manifests, latestVersions)
  const report = renderReport(edits, complexSkips)

  const updated = Object.fromEntries(
    [...new Set(edits.map(edit => edit.name))].sort().map(name => [name, latestVersions.get(name)])
  )
  if (summaryFile != null) {
    // outputJson (not writeJson): the workflow points this into a not-yet-
    // existing update-output/ directory, and outputJson creates parent dirs.
    await fs.outputJson(String(summaryFile), { updated, editCount: edits.length }, { spaces: ManifestJsonSpaces })
  }
  if (reportFile != null) {
    await fs.outputFile(String(reportFile), report)
  }

  if (jsonOutput) {
    // --json: stdout carries exactly ONE machine-readable document — nothing
    // else may print on stdout in this mode, or piped `jq` consumers break.
    const relativeEdits = edits.map(edit => ({ ...edit, file: path.relative(repoRoot, edit.file) }))
    const relativeSkips = complexSkips.map(skip => ({ ...skip, file: path.relative(repoRoot, skip.file) }))
    echo(
      JSON.stringify(
        { dryRun, editCount: edits.length, updated, edits: relativeEdits, complexSkips: relativeSkips, registrySkips },
        null,
        ManifestJsonSpaces
      )
    )
  } else {
    echo(report)
  }

  if (edits.length === 0) {
    if (!jsonOutput) {
      echo(chalk.green("already current — nothing to write"))
    }
    return
  }
  if (dryRun) {
    if (!jsonOutput) {
      echo(chalk.yellow(`--dry-run: ${edits.length} declaration(s) would update — not writing`))
    }
    // exitCode, not process.exit(): exit() can truncate still-flushing stdout
    // on CI pipes — the output above must always land. Exit 2 = updates are
    // available (a script-friendly drift signal).
    process.exitCode = 2
    return
  }

  const changedManifests = manifests.filter(({ file }) => edits.some(edit => edit.file === file))
  await Promise.all(
    changedManifests.map(({ file, json }) => fs.writeJson(file, json, { spaces: ManifestJsonSpaces }))
  )
  if (!jsonOutput) {
    echo(chalk.green(`updated ${edits.length} declaration(s) across ${changedManifests.length} manifest(s)`))
  }
}

main().catch(error => {
  // console.error (the CLI-script carve-out): errors go to stderr so a piped
  // --json stdout stays parseable; consumers check the exit code first.
  console.error(chalk.red(`update-wireio-deps: ${error.message}`))
  // exitCode, not process.exit(): let stdout/stderr drain so the error above
  // is never truncated on CI pipes.
  process.exitCode = 1
})
