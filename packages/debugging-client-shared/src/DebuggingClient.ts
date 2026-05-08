import type {
  ClusterConfig,
  ClusterState,
  InferredStreamEvent,
  InferredStreamParams,
  LoadEnvelopeRecordsRequest,
  LoadEnvelopeRecordsResponse,
  LogReadRequest,
  LogStat,
  PidSource,
  ProcessLivenessSnapshot,
  StreamTopic
} from "@wireio/debugging-shared"
import type {
  GetEnvelopeResponse,
  ListEnvelopesRequest,
  ListEnvelopesResponse
} from "@wireio/opp-typescript-models"

import type { DebuggingSubscription } from "./subscriptions/index.js"

/**
 * Transport-agnostic interface for every operation the TUI (and future
 * debugging consumers) need. Concrete subclasses implement the wire — disk
 * vs. HTTP+WebSocket — but expose the exact same shape so consumer code
 * never branches on transport.
 *
 * Lifecycle: callers should `await connect()` after construction and
 * `disconnect()` before discarding the instance. Both are idempotent.
 */
export abstract class DebuggingClient {
  /**
   * Open any underlying transports (TCP/WebSocket/etc). Local-disk
   * implementations no-op. Calling twice is safe.
   */
  abstract connect(): Promise<void>

  /**
   * Tear down transports and close every active subscription. Calling
   * twice is safe.
   */
  abstract disconnect(): Promise<void>

  // -------------------------------------------------------------------------
  //  Cluster
  // -------------------------------------------------------------------------

  /** Current cluster config. Throws when `cluster-config.json` is unreadable. */
  abstract getClusterConfig(): Promise<ClusterConfig>

  /** Post-bootstrap cluster state. `null` when the cluster has not bootstrapped yet. */
  abstract getClusterState(): Promise<ClusterState | null>

  // -------------------------------------------------------------------------
  //  Process monitor
  // -------------------------------------------------------------------------

  /** Filesystem-discovered pid-file-backed source list. */
  abstract listProcessSources(): Promise<PidSource[]>

  /**
   * Probe kernel liveness for each requested label. Empty `labels` probes
   * every known source; otherwise returns one snapshot per requested label.
   */
  abstract getProcessLiveness(
    labels: string[]
  ): Promise<ProcessLivenessSnapshot[]>

  // -------------------------------------------------------------------------
  //  Logs
  // -------------------------------------------------------------------------

  /** Stat snapshot for a log file (`totalBytes`, `totalLines`, `ino`). */
  abstract getLogStat(path: string): Promise<LogStat>

  /** Read a `[fromLine, fromLine+count)` window of a log file. */
  abstract readLogWindow(req: LogReadRequest): Promise<string[]>

  // -------------------------------------------------------------------------
  //  OPP envelope debug
  // -------------------------------------------------------------------------

  /** List stored envelopes matching the filters in `req`. */
  abstract listEnvelopes(
    req: ListEnvelopesRequest
  ): Promise<ListEnvelopesResponse>

  /** Read one stored envelope by storage key. */
  abstract getEnvelope(key: string): Promise<GetEnvelopeResponse>

  /**
   * Bulk-fetch fully-decoded epoch records matching a filter — used by
   * "load older" affordances in UIs. Returns the same plainified shape
   * the `EnvelopeWatch` stream emits, so the consumer's slice-update
   * code path is identical to the live-tail path.
   */
  abstract loadEnvelopeRecords(
    req: LoadEnvelopeRecordsRequest
  ): Promise<LoadEnvelopeRecordsResponse>

  // -------------------------------------------------------------------------
  //  Streams
  // -------------------------------------------------------------------------

  /**
   * Open a subscription on the given topic. Returns a typed
   * `DebuggingSubscription` whose `event` listener receives the topic's
   * payload type. Consumer must call `close()` to tear down.
   */
  abstract subscribe<T extends StreamTopic>(
    topic: T,
    params: InferredStreamParams<T>
  ): Promise<DebuggingSubscription<InferredStreamEvent<T>>>
}
