#!/usr/bin/env node
/**
 * Run an e2e flow test against a WIRE cluster.
 *
 * Usage:
 *   ./scripts/run-flow.mjs [name-or-pattern] [options]
 *
 *   name-or-pattern   Either an exact flow name (e.g. `flow-swap-with-underwriting`,
 *                     or the short form `swap-with-underwriting`) or a regex pattern
 *                     matched against the discovered flow names. When omitted, an
 *                     interactive picker lists every flow under `packages/flow-*`.
 *
 * Options (each falls back to the matching env var; one of the two is required):
 *   --wire-build-path <dir>   wire-sysio build dir (env: WIRE_BUILD_PATH) — must contain bin/nodeop
 *   --ethereum-path   <dir>   wire-ethereum repo root (env: WIRE_ETH_PATH) — must contain hardhat.config.ts
 *   --solana-path     <dir>   wire-solana repo root (env: WIRE_SOLANA_PATH)
 *
 *   --cluster-path <dir>      cluster data dir (env: WIRE_CLUSTER_PATH). Optional — when omitted
 *                             the flow test harness generates a fresh temp cluster path per run.
 *
 * Examples:
 *   ./scripts/run-flow.mjs                       # interactive picker
 *   ./scripts/run-flow.mjs swap                  # regex match → picks/prompts among matches
 *   ./scripts/run-flow.mjs flow-swap-with-underwriting --wire-build-path ~/wire-sysio/build/release \
 *       --ethereum-path ~/wire-ethereum --solana-path ~/wire-solana
 */

import { fileURLToPath } from "node:url"
import { argv, chalk, echo, fs, glob, path, question, $ } from "zx"

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
/** Repo root = wire-tools-ts (one level up from scripts/). */
const repoRoot = path.resolve(scriptDir, "..")
/** Where flow packages live. */
const flowsGlob = path.join(repoRoot, "packages", "flow-*")

// ---------------------------------------------------------------------------
// Flow discovery
// ---------------------------------------------------------------------------

/**
 * Discover every flow package under `packages/flow-*`, dynamically — new flows
 * are picked up automatically, there is no static list to maintain.
 *
 * @return {Promise<Array<{ name: string, short: string, dir: string, pkgName: string, description: string }>>}
 *   one entry per flow, sorted by name.
 */
async function discoverFlows() {
  const dirs = await glob(flowsGlob, { onlyDirectories: true })
  const flows = dirs.map(dir => {
    const name = path.basename(dir)
    const pkgJsonPath = path.join(dir, "package.json")
    const pkg = fs.existsSync(pkgJsonPath) ? fs.readJsonSync(pkgJsonPath) : {}
    return {
      name,
      short: name.replace(/^flow-/, ""),
      dir,
      pkgName: pkg.name ?? name,
      description: pkg.description ?? ""
    }
  })
  return flows.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Filter flows by an exact-name or regex `name-or-pattern`.
 *
 * Exact match (against the full `flow-*` name or its short form) wins and
 * short-circuits to a single result; otherwise the value is treated as a
 * regex tested against the flow name, falling back to a substring match when
 * the value is not a valid regex.
 *
 * @param {Array<{ name: string, short: string }>} flows discovered flows.
 * @param {string} pattern the user-supplied name-or-pattern.
 * @return {Array} the subset of `flows` that match.
 */
function matchFlows(flows, pattern) {
  const exact = flows.find(
    f => f.name === pattern || f.short === pattern || `flow-${pattern}` === f.name
  )
  if (exact) return [exact]

  let test
  try {
    const re = new RegExp(pattern, "i")
    test = f => re.test(f.name)
  } catch {
    test = f => f.name.includes(pattern)
  }
  return flows.filter(test)
}

/**
 * Prompt the user to choose one flow from a list, by number or by name.
 *
 * @param {Array<{ name: string, description: string }>} flows candidates to present.
 * @return {Promise<object>} the chosen flow entry.
 */
async function promptForFlow(flows) {
  echo(chalk.bold("\nAvailable flows:"))
  flows.forEach((f, i) => {
    const num = chalk.cyan(String(i + 1).padStart(2))
    const desc = f.description ? chalk.dim(` — ${f.description}`) : ""
    echo(`  ${num}  ${f.name}${desc}`)
  })

  const names = flows.map(f => f.name)
  while (true) {
    const answer = (
      await question(chalk.bold(`\nSelect a flow [1-${flows.length} or name]: `), {
        choices: names
      })
    ).trim()

    if (answer.length === 0) {
      echo(chalk.red("Aborted — no flow selected."))
      process.exit(1)
    }

    const asNum = Number(answer)
    if (Number.isInteger(asNum) && asNum >= 1 && asNum <= flows.length) {
      return flows[asNum - 1]
    }

    const matched = matchFlows(flows, answer)
    if (matched.length === 1) return matched[0]
    if (matched.length > 1) {
      echo(chalk.yellow(`"${answer}" matches ${matched.length} flows — be more specific.`))
      continue
    }
    echo(chalk.yellow(`No flow matches "${answer}" — try again.`))
  }
}

/**
 * Resolve the single flow to run from the CLI `name-or-pattern` (or interactively).
 *
 * @param {Array} flows discovered flows.
 * @param {string|null} pattern the CLI name-or-pattern, or null when omitted.
 * @return {Promise<object>} the selected flow entry.
 */
async function resolveFlow(flows, pattern) {
  if (pattern == null) return promptForFlow(flows)

  const matched = matchFlows(flows, pattern)
  if (matched.length === 0) {
    echo(chalk.red(`No flow matches "${pattern}".`))
    echo(chalk.dim("Available: " + flows.map(f => f.name).join(", ")))
    process.exit(1)
  }
  if (matched.length === 1) return matched[0]

  echo(chalk.yellow(`"${pattern}" matches ${matched.length} flows:`))
  return promptForFlow(matched)
}

// ---------------------------------------------------------------------------
// Required path resolution (CLI flag → env var → error)
// ---------------------------------------------------------------------------

/**
 * Resolve a required path from its CLI flag, falling back to an env var.
 * Exits with an error when neither is supplied.
 *
 * @param {string|undefined} flagValue value of the CLI flag (or undefined).
 * @param {string} envVar the env var name to fall back to.
 * @param {string} flagName the flag name (for error messages).
 * @return {string} the resolved absolute path.
 */
function requirePath(flagValue, envVar, flagName) {
  const value = flagValue ?? process.env[envVar] ?? null
  if (value == null || String(value).length === 0) {
    echo(chalk.red(`Error: ${flagName} is required (or set ${envVar}).`))
    process.exit(1)
  }
  return path.resolve(String(value))
}

/**
 * Assert a path exists and is a directory; exit otherwise.
 *
 * @param {string} dir the directory to check.
 * @param {string} label human-readable label for the error message.
 */
function assertDir(dir, label) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    echo(chalk.red(`Error: ${label} does not exist: ${dir}`))
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const flows = await discoverFlows()
if (flows.length === 0) {
  echo(chalk.red(`No flow packages found under ${flowsGlob}`))
  process.exit(1)
}

const pattern = argv._[0] != null ? String(argv._[0]) : null
const flow = await resolveFlow(flows, pattern)

// Required paths: CLI flag wins, else env var, else error.
const wireBuildPath = requirePath(
  argv["wire-build-path"],
  "WIRE_BUILD_PATH",
  "--wire-build-path"
)
const ethereumPath = requirePath(argv["ethereum-path"], "WIRE_ETH_PATH", "--ethereum-path")
const solanaPath = requirePath(argv["solana-path"], "WIRE_SOLANA_PATH", "--solana-path")

// Validate the resolved paths.
assertDir(wireBuildPath, "wire build path")
const nodeop = path.join(wireBuildPath, "bin", "nodeop")
if (!fs.existsSync(nodeop)) {
  echo(chalk.red(`Error: nodeop not found at ${nodeop}`))
  process.exit(1)
}
assertDir(ethereumPath, "ethereum path")
const hardhatConfig = path.join(ethereumPath, "hardhat.config.ts")
if (!fs.existsSync(hardhatConfig)) {
  echo(chalk.red(`Error: not a wire-ethereum repo (no hardhat.config.ts): ${ethereumPath}`))
  process.exit(1)
}
assertDir(solanaPath, "solana path")

// Cluster path is optional: only an explicit --cluster-path (or pre-set
// WIRE_CLUSTER_PATH) is honored. When neither is provided, WIRE_CLUSTER_PATH
// is left unset so the flow test harness generates a fresh temp cluster path.
const clusterPath =
  argv["cluster-path"] != null
    ? path.resolve(String(argv["cluster-path"]))
    : (process.env.WIRE_CLUSTER_PATH ?? null)

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

echo(chalk.bold.green(`\nRunning ${flow.pkgName}...`))
echo(`  wire-build: ${wireBuildPath}`)
echo(`  ethereum:   ${ethereumPath}`)
echo(`  solana:     ${solanaPath}`)
echo(`  cluster:    ${clusterPath ?? chalk.dim("(harness-generated temp dir)")}`)

const childEnv = {
  ...process.env,
  WIRE_BUILD_PATH: wireBuildPath,
  WIRE_ETH_PATH: ethereumPath,
  WIRE_SOLANA_PATH: solanaPath,
  // Only forward WIRE_CLUSTER_PATH when explicitly set; otherwise let the harness pick a temp dir.
  ...(clusterPath != null ? { WIRE_CLUSTER_PATH: clusterPath } : {})
}

// IMPORTANT: run jest with INHERITED stdio (a real TTY), exactly as a developer
// running `pnpm --filter <pkg> test` in a terminal would. Letting zx capture the
// child's output instead (the `$`...`` default) hands jest a non-TTY pipe AND
// buffers every line in memory for the whole run — over a multi-minute flow that
// changes tool behavior and starves the bootstrap, blowing past the 300s
// `beforeAll` budget. `pnpm --filter` also matches the working invocation 1:1
// (same jest binary, same package jest.config.ts) rather than a hand-rolled
// `npx jest` with divergent flags.
await $({
  stdio: "inherit",
  cwd: repoRoot,
  env: childEnv
})`pnpm --filter ${flow.pkgName} test`
