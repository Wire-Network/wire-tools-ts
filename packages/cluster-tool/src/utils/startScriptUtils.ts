import Path from "node:path"

/**
 * Shell variables a rendered `start.sh` expands at run time. Each stands in for
 * an absolute path that must NOT be frozen into the script — the build host's
 * layout is not the deploy host's.
 *
 * `NODE_DIR` / `CLUSTER_DIR` are derived by the script's own preamble from
 * `BASH_SOURCE`, so the tree relocates freely. The `WIRE_*` roots name
 * host-supplied trees (binaries, outpost repos) the cluster directory never
 * contains, so the operator exports them.
 */
export enum StartScriptVariable {
  NODE_DIR = "NODE_DIR",
  CLUSTER_DIR = "CLUSTER_DIR",
  /**
   * The wire-sysio install PREFIX — the directory holding `bin/nodeop`.
   *
   * Named for what a consumer supplies, not for how this cluster was built: on
   * the deploy host there is usually no "build directory" at all, just an
   * installed tree (or a `nodeop` already on `PATH`, from which the script
   * derives the prefix itself). `WIRE_BUILD_PATH` remains an accepted fallback.
   */
  WIRE_PREFIX_PATH = "WIRE_PREFIX_PATH",
  WIRE_ETH_PATH = "WIRE_ETH_PATH",
  WIRE_SOLANA_PATH = "WIRE_SOLANA_PATH"
}

/** One absolute-path prefix and the shell variable that replaces it. */
export interface StartScriptRelocation {
  /** Absolute path prefix to match (a path root on the BUILD host). */
  readonly prefix: string
  /** The variable substituted in its place. */
  readonly variable: StartScriptVariable
}

/**
 * Order a relocation table longest-prefix-first so a nested root wins over its
 * parent — a node dir lives UNDER the cluster dir, so `nodePath` must be tried
 * before `clusterPath` or every node path would relocate to `$CLUSTER_DIR`.
 *
 * Entries with an empty prefix are dropped: an unset root (no ethereum path on
 * a depot-only cluster) must never match every token via `""`.
 *
 * @param relocations - Candidate prefix→variable mappings, any order.
 * @returns The usable entries, longest prefix first.
 */
export function orderRelocations(
  relocations: readonly StartScriptRelocation[]
): StartScriptRelocation[] {
  return relocations
    .filter(relocation => relocation.prefix != null && relocation.prefix !== "")
    .slice()
    .sort((left, right) => right.prefix.length - left.prefix.length)
}

/**
 * Single-quote a literal shell word — the only fully-inert quoting form: inside
 * `'…'` every character is literal, so `$`, backticks, `\` and whitespace cannot
 * be re-interpreted. An embedded `'` is emitted as `'\''` (close, escaped quote,
 * reopen).
 *
 * @param value - Raw literal text.
 * @returns The text as one single-quoted shell word.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * Does `path` sit at, or under, `prefix`?
 *
 * Separator-BOUNDARY match: a bare `startsWith` would relocate a SIBLING that
 * merely shares the prefix string (`/tmp/cluster-2` under `/tmp/cluster`). An
 * empty prefix never matches — it would otherwise swallow every token.
 *
 * THE one prefix predicate. Every consumer — token rewriting, the shell-test
 * quoting in `DaemonConfig`, and the renderer's required-root assertions —
 * calls this, because those consumers decide two halves of one contract: which
 * tokens become `"$VAR"` expansions, and which `: "${VAR:?…}"` guards are
 * emitted. If they ever disagreed, a token would relocate onto a root with no
 * guard behind it, and `set -u` does NOT catch a set-but-EMPTY variable — the
 * expansion would silently yield an absolute path on the wrong root.
 *
 * @param path - Candidate path (an argv token, or an executable path).
 * @param prefix - The relocation's absolute root.
 * @returns `true` when `path` is `prefix` itself or lies beneath it.
 */
export function matchesPrefix(path: string, prefix: string): boolean {
  return (
    prefix !== "" && (path === prefix || path.startsWith(prefix + Path.sep))
  )
}

/**
 * Rewrite ONE argv token against the relocation table.
 *
 * A matched token renders as an expanded variable concatenated with the
 * single-quoted remainder — `"$CLUSTER_DIR"'/data/anvil/anvil.json'`. Adjacent
 * quoted segments are one shell word, so the variable expands while the
 * remainder stays inert. A token that matches nothing is single-quoted whole.
 *
 * @param token - One argv entry.
 * @param relocations - Table, already ordered by {@link orderRelocations}.
 * @returns The token as a shell word.
 */
export function toRelocatableToken(
  token: string,
  relocations: readonly StartScriptRelocation[]
): string {
  const match = relocations.find(relocation =>
    matchesPrefix(token, relocation.prefix)
  )
  if (match == null) return shellQuote(token)
  const remainder = token.slice(match.prefix.length)
  return remainder === ""
    ? `"$${match.variable}"`
    : `"$${match.variable}"${shellQuote(remainder)}`
}

/**
 * Rewrite a whole argv against the relocation table — every build-host absolute
 * path becomes a variable expansion, everything else is quoted literally.
 *
 * @param argv - The argv to relocate (WITHOUT the executable).
 * @param relocations - Candidate prefix→variable mappings, any order.
 * @returns One shell word per argv entry, ready to join with spaces.
 */
export function toRelocatableArgv(
  argv: readonly string[],
  relocations: readonly StartScriptRelocation[]
): string[] {
  const ordered = orderRelocations(relocations)
  return argv.map(token => toRelocatableToken(token, ordered))
}
