import Fs from "node:fs"
import Path from "node:path"
import { match } from "ts-pattern"
import {
  NodeRole,
  type ClusterState,
  type NodeState
} from "@wireio/debugging-shared"
import { currentDateStamp } from "./dateStamp.js"

/** Classifies a monitored process for display grouping and fallback handling. */
export enum PidSourceKind {
  Bios = "bios",
  Producer = "producer",
  BatchOperator = "batch-operator",
  Underwriter = "underwriter",
  Anvil = "anvil",
  SolanaValidator = "solana-validator"
}

/** A pid-file-backed process known to the TUI. */
export interface PidSource {
  /** Filename label (no `.pid` suffix); always matches what ProcessManager wrote. */
  label: string
  /** Absolute pid file path. */
  pidPath: string
  /** Directory containing the pid file; usable for log discovery. */
  directory: string
  /** Semantic classification. */
  kind: PidSourceKind
  /** Present when the source is one of the WIRE node arrays. */
  node?: NodeState
}

export namespace PidSources {
  /** Filename suffix used by harness ProcessManager for pid files. */
  export const PidExt = ".pid" as const
  /** Relative subpath of the anvil data dir under a cluster root. */
  export const AnvilSubpath = "data/anvil" as const
  /**
   * Relative subpath of the solana-test-validator pid dir. The harness's
   * `ProcessManager.toProcessPath` derives this dir from the label by
   * `label.replaceAll("-", "_")`, so `solana-test-validator` lands in
   * `data/solana_test_validator/`. The sibling `data/solana_validator/`
   * directory is the validator's *ledger*, not its pid dir.
   */
  export const SolanaSubpath = "data/solana_test_validator" as const
  /** Subdirectory under every source's `directory` that holds its log files. */
  export const LogsSubdir = "logs" as const
  /** Filename suffix used by nodeop's JSONL daily-file sink. */
  export const JsonlExt = ".jsonl" as const
  /** Filename prefix for the plain stderr-captured daily log. */
  export const PlainLogPrefix = "log_" as const
  /** Filename suffix for the plain stderr-captured daily log. */
  export const PlainLogExt = ".log" as const
  /** `nodeId` that identifies the genesis-bootstrap node in `NodeState`. */
  export const BiosNodeId = "bios" as const
}

/** Kind for a NodeState based on role + bios-nodeId heuristic. */
function kindForNode(node: NodeState): PidSourceKind {
  return match({
    role: node.role ?? NodeRole.Producer,
    nodeId: node.nodeId
  })
    .with({ role: NodeRole.BatchOperator }, () => PidSourceKind.BatchOperator)
    .with({ role: NodeRole.Underwriter }, () => PidSourceKind.Underwriter)
    .with({ nodeId: PidSources.BiosNodeId }, () => PidSourceKind.Bios)
    .otherwise(() => PidSourceKind.Producer)
}

interface RawPid {
  label: string
  pidPath: string
}

/** List pid files under `dir` if it exists. Returns `[]` when missing. */
function readPidFiles(dir: string): RawPid[] {
  if (!Fs.existsSync(dir)) return []
  return Fs.readdirSync(dir)
    .filter(f => f.endsWith(PidSources.PidExt))
    .map(f => ({
      label: f.slice(0, -PidSources.PidExt.length),
      pidPath: Path.join(dir, f)
    }))
}

/** Pid files in a NodeState's `dataPath`, tagged with its {@link PidSourceKind}. */
function sourcesForNode(node: NodeState): PidSource[] {
  const kind = kindForNode(node)
  return readPidFiles(node.dataPath).map(raw => ({
    label: raw.label,
    pidPath: raw.pidPath,
    directory: node.dataPath,
    kind,
    node
  }))
}

/** Pid files in a known non-node subdir (anvil, solana-test-validator). */
function sourcesForSubdir(
  clusterPath: string,
  subpath: string,
  kind: PidSourceKind
): PidSource[] {
  const dir = Path.join(clusterPath, subpath)
  return readPidFiles(dir).map(raw => ({
    label: raw.label,
    pidPath: raw.pidPath,
    directory: dir,
    kind
  }))
}

/**
 * Enumerate every monitored process for a cluster. Discovered by filesystem
 * scan — no label construction, no nodeId parsing. Covers:
 *   - producer / bios / batch-operator / underwriter nodeop processes
 *   - anvil (if present)
 *   - solana-test-validator (if present)
 *
 * @param clusterPath cluster root (absolute)
 * @param state parsed `cluster-state.json`, or null when the cluster hasn't bootstrapped
 */
export function collectPidSources(
  clusterPath: string,
  state: ClusterState | null
): PidSource[] {
  if (!state) return []
  const nodeSources: PidSource[] = [
    ...state.nodes.flatMap(sourcesForNode),
    ...state.batchOperatorNodes.flatMap(sourcesForNode),
    ...state.underwriterNodes.flatMap(sourcesForNode)
  ]
  const anvilSources = sourcesForSubdir(
      clusterPath,
      PidSources.AnvilSubpath,
      PidSourceKind.Anvil
    ),
    solanaSources = sourcesForSubdir(
      clusterPath,
      PidSources.SolanaSubpath,
      PidSourceKind.SolanaValidator
    )
  // Stable sort by label so re-renders don't reshuffle the list out from
  // under a cursor that's tracking by index. Filesystem order from
  // `Fs.readdirSync` is implementation-defined and can vary if pid files
  // are recreated on respawn.
  return [...nodeSources, ...anvilSources, ...solanaSources].sort((a, b) =>
    a.label.localeCompare(b.label)
  )
}

/**
 * Resolve the preferred log file for a source.
 *
 * Scans `<source.directory>/logs/` for `*.jsonl` files (nodeop's JSONL
 * daily-file sink). When at least one is present the lex-latest one wins —
 * the JSONL filenames embed an ISO date so lexical order is chronological.
 * When no JSONL is available (anvil / solana / pre-rotation) the today plain
 * `log_<YYYYMMDD>.log` path is returned.
 *
 * @param source process whose log to surface in the viewer
 * @param now    date used for the plain-log fallback filename; defaults to current time
 */
export function logPathForSource(
  source: PidSource,
  now: Date = new Date()
): string {
  const logsDir = Path.join(source.directory, PidSources.LogsSubdir),
    jsonl = latestJsonlIn(logsDir)
  if (jsonl) return Path.join(logsDir, jsonl)
  return Path.join(
    logsDir,
    `${PidSources.PlainLogPrefix}${currentDateStamp(now)}${PidSources.PlainLogExt}`
  )
}

/** Lex-latest `*.jsonl` filename in `logsDir`, or null when there are none. */
function latestJsonlIn(logsDir: string): string | null {
  if (!Fs.existsSync(logsDir)) return null
  const matches = Fs.readdirSync(logsDir)
    .filter(f => f.endsWith(PidSources.JsonlExt))
    .sort()
  return matches.length === 0 ? null : matches[matches.length - 1]
}
