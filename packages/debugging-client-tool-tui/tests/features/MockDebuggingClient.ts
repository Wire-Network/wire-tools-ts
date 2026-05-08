import {
  ClosedReason,
  type ClusterConfig,
  type ClusterState,
  type InferredStreamEvent,
  type InferredStreamParams,
  type LoadEnvelopeRecordsRequest,
  type LoadEnvelopeRecordsResponse,
  type LogReadRequest,
  type LogStat,
  type PidSource,
  type ProcessLivenessSnapshot,
  type StreamTopic
} from "@wireio/debugging-shared"
import {
  DebuggingClient,
  DebuggingSubscription
} from "@wireio/debugging-client-shared"
import type {
  GetEnvelopeResponse,
  ListEnvelopesRequest,
  ListEnvelopesResponse
} from "@wireio/opp-typescript-models"

/**
 * Test-friendly `DebuggingClient` whose responses and stream events are
 * driven by the test caller. Each unary method has a `set*` helper to
 * pre-load the response; `subscribe()` returns a typed subscription
 * whose `emit()` and `close()` can be invoked by the test to simulate
 * server-pushed events.
 */
export class MockDebuggingClient extends DebuggingClient {
  private clusterConfig: ClusterConfig | null = null
  private clusterState: ClusterState | null = null
  private processSources: PidSource[] = []
  private livenessByLabel = new Map<string, ProcessLivenessSnapshot>()
  private logStats = new Map<string, LogStat>()
  private logWindows = new Map<string, string[]>()
  private envelopeListResponse: ListEnvelopesResponse | null = null
  private envelopeByKey = new Map<string, GetEnvelopeResponse>()
  private nextSubId = 1
  private subscriptions: Array<{
    id: number
    topic: StreamTopic
    sub: DebuggingSubscription<unknown>
  }> = []

  setClusterConfig(c: ClusterConfig): this {
    this.clusterConfig = c
    return this
  }

  setClusterState(s: ClusterState | null): this {
    this.clusterState = s
    return this
  }

  setProcessSources(s: PidSource[]): this {
    this.processSources = s
    return this
  }

  setLivenessForLabel(label: string, snap: ProcessLivenessSnapshot): this {
    this.livenessByLabel.set(label, snap)
    return this
  }

  setLogStat(path: string, stat: LogStat): this {
    this.logStats.set(path, stat)
    return this
  }

  setLogWindow(path: string, lines: string[]): this {
    this.logWindows.set(path, lines)
    return this
  }

  setEnvelopeList(resp: ListEnvelopesResponse): this {
    this.envelopeListResponse = resp
    return this
  }

  setEnvelope(key: string, resp: GetEnvelopeResponse): this {
    this.envelopeByKey.set(key, resp)
    return this
  }

  /** Invoked by the test to push an event into the active subscription for `topic`. */
  emit<T extends StreamTopic>(
    topic: T,
    payload: InferredStreamEvent<T>
  ): void {
    this.subscriptions
      .filter(s => s.topic === topic)
      .forEach(s =>
        (s.sub as DebuggingSubscription<InferredStreamEvent<T>>).emitEvent(
          payload
        )
      )
  }

  /** Active subscription objects in registration order. */
  get activeSubscriptions(): ReadonlyArray<{
    id: number
    topic: StreamTopic
    sub: DebuggingSubscription<unknown>
  }> {
    return this.subscriptions
  }

  // -------------------------------------------------------------------------
  //  DebuggingClient implementation
  // -------------------------------------------------------------------------

  async connect(): Promise<void> {
    /* no-op */
  }

  async disconnect(): Promise<void> {
    this.subscriptions.forEach(s =>
      s.sub.notifyClosed(ClosedReason.ServerShutdown)
    )
    this.subscriptions = []
  }

  async getClusterConfig(): Promise<ClusterConfig> {
    if (!this.clusterConfig) throw new Error("MockDebuggingClient: no cluster config set")
    return this.clusterConfig
  }

  async getClusterState(): Promise<ClusterState | null> {
    return this.clusterState
  }

  async listProcessSources(): Promise<PidSource[]> {
    return this.processSources
  }

  async getProcessLiveness(
    labels: string[]
  ): Promise<ProcessLivenessSnapshot[]> {
    if (labels.length === 0) {
      return [...this.livenessByLabel.values()]
    }
    return labels
      .map(l => this.livenessByLabel.get(l))
      .filter((s): s is ProcessLivenessSnapshot => !!s)
  }

  async getLogStat(path: string): Promise<LogStat> {
    const stat = this.logStats.get(path)
    if (!stat) throw new Error(`MockDebuggingClient: no LogStat set for ${path}`)
    return stat
  }

  async readLogWindow(req: LogReadRequest): Promise<string[]> {
    const all = this.logWindows.get(req.path) ?? []
    return all.slice(req.fromLine, req.fromLine + req.count)
  }

  async listEnvelopes(_req: ListEnvelopesRequest): Promise<ListEnvelopesResponse> {
    if (!this.envelopeListResponse)
      throw new Error("MockDebuggingClient: no envelope list set")
    return this.envelopeListResponse
  }

  async getEnvelope(key: string): Promise<GetEnvelopeResponse> {
    const resp = this.envelopeByKey.get(key)
    if (!resp) throw new Error(`MockDebuggingClient: no envelope for key ${key}`)
    return resp
  }

  async loadEnvelopeRecords(
    _req: LoadEnvelopeRecordsRequest
  ): Promise<LoadEnvelopeRecordsResponse> {
    return { records: [] }
  }

  async subscribe<T extends StreamTopic>(
    topic: T,
    _params: InferredStreamParams<T>
  ): Promise<DebuggingSubscription<InferredStreamEvent<T>>> {
    const id = this.nextSubId++,
      sub = new DebuggingSubscription<InferredStreamEvent<T>>(
        id,
        topic,
        () => {
          this.subscriptions = this.subscriptions.filter(s => s.id !== id)
        }
      )
    this.subscriptions.push({
      id,
      topic,
      sub: sub as DebuggingSubscription<unknown>
    })
    return sub
  }
}
