import type { NodeState } from "../cluster/index.js"

/** Classifies a monitored process for display grouping and fallback handling. */
export enum PidSourceKind {
  Bios = "bios",
  Producer = "producer",
  BatchOperator = "batch-operator",
  Underwriter = "underwriter",
  Anvil = "anvil",
  SolanaValidator = "solana-validator"
}

/**
 * A pid-file-backed process known to the debugging surface. Carries enough
 * information that both the local-disk client and the network client can
 * treat the source as opaque (using `label` as the identifier) while still
 * surfacing diagnostic context.
 */
export interface PidSource {
  /** Filename label (no `.pid` suffix); always matches what ProcessManager wrote. */
  label: string
  /** Absolute pid file path on the producing machine. Server-side path; remote clients treat as opaque. */
  pidPath: string
  /** Directory containing the pid file; usable for log discovery. */
  directory: string
  /** Semantic classification. */
  kind: PidSourceKind
  /** Present when the source is one of the WIRE node arrays. */
  node?: NodeState
}

/** Per-label kernel-liveness snapshot from a pid-file probe. */
export interface ProcessLivenessSnapshot {
  /** Source label that this snapshot pertains to. */
  label: string
  /** Pid read from the pid file. `null` when the pid file is missing or malformed. */
  pid: number | null
  /** Result of `process.kill(pid, 0)` — `true` when the kernel reports the process exists. */
  alive: boolean
  /** Wall-clock time (ms since epoch) the snapshot was produced. */
  lastCheckedAt: number
  /** First poll where `alive` flipped to `false`. `null` when still alive or never observed alive. */
  exitedAt: number | null
}

/**
 * Diff event emitted by a process-monitor stream subscription. The server
 * runs the snapshot loop and pushes only what changed; the client merges
 * `setSnapshots` into its current state and drops `removedLabels`.
 */
export interface ProcessLivenessEvent {
  /** Snapshots whose values changed (or were observed for the first time). */
  setSnapshots: ProcessLivenessSnapshot[]
  /** Labels whose pid file disappeared since the prior tick. */
  removedLabels: string[]
}

/** Empty request body for `Processes.List`. */
export interface ListProcessesRequest {}

/** Response body for `Processes.List`. */
export interface ListProcessesResponse {
  /** Every monitored pid-file-backed source the server can see right now. */
  sources: PidSource[]
}

/** Request body for `Processes.GetLiveness`. */
export interface GetProcessLivenessRequest {
  /** Subset of source labels to probe. Empty array probes every known source. */
  labels: string[]
}

/** Response body for `Processes.GetLiveness`. */
export interface GetProcessLivenessResponse {
  /** Liveness snapshots, one per requested label. */
  snapshots: ProcessLivenessSnapshot[]
}

/** Empty params object for the `ProcessLiveness` stream subscription. */
export interface ProcessLivenessStreamParams {}
