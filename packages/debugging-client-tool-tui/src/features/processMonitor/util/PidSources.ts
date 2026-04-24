import Fs from "node:fs"
import Path from "node:path"
import { match } from "ts-pattern"
import {
  NodeRole,
  type ClusterState,
  type NodeState
} from "@wire-e2e-tests/debugging-shared"

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
  /** Relative subpath of the solana-test-validator data dir. */
  export const SolanaSubpath = "data/solana_validator" as const
}

/** Kind for a NodeState based on role + bios-nodeId heuristic. */
function kindForNode(node: NodeState): PidSourceKind {
  return match({
    role: node.role ?? NodeRole.Producer,
    nodeId: node.nodeId
  })
    .with({ role: NodeRole.BatchOperator }, () => PidSourceKind.BatchOperator)
    .with({ role: NodeRole.Underwriter }, () => PidSourceKind.Underwriter)
    .with({ nodeId: "bios" }, () => PidSourceKind.Bios)
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
  return [...nodeSources, ...anvilSources, ...solanaSources]
}

/** Absolute log path for a source on a given datestamp. */
export function logPathForSource(
  source: PidSource,
  datestamp: string
): string {
  return Path.join(source.directory, "logs", `log_${datestamp}.log`)
}
