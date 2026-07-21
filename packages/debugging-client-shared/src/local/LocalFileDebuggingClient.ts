import * as Fs from "node:fs"
import * as Path from "node:path"
import {
  ClusterConfigSchemaCodec,
  ClusterFiles,
  ClusterStateSchemaCodec,
  type ClusterConfig,
  type ClusterState
} from "@wireio/cluster-tool-shared"
import { createHash } from "node:crypto"

import Bluebird from "bluebird"
import { match } from "ts-pattern"
import { NestedError } from "@wireio/shared"

import {
  EnvelopeEventKind,
  StreamTopic,
  buildLineIndex,
  collectPidSources,
  endpointsTypeToKey,
  extendLineIndex,
  oppDebuggingPath,
  parseEnvelopeStorageKey,
  pidIsAlive,
  plainify,
  readEnvelopeRecordsFromDir,
  readPid,
  readLines,
  resolveEndpointsType,
  type DebugOPPEnvelopeRecord,
  type EnvelopeEvent,
  type InferredStreamEvent,
  type InferredStreamParams,
  type LineIndex,
  type LoadEnvelopeRecordsRequest,
  type LoadEnvelopeRecordsResponse,
  type LogReadRequest,
  type LogStat,
  type LogTailEvent,
  type LogTailParams,
  type PidSource,
  type ProcessLivenessEvent,
  type ProcessLivenessSnapshot
} from "@wireio/debugging-shared"
import {
  DebugEnvelopeMetadataRecord,
  DebugOutpostEndpointsType,
  EnvelopeListEntry,
  Envelope,
  GetEnvelopeResponse,
  ListEnvelopesResponse,
  PutEnvelopeResponse,
  type ListEnvelopesRequest,
  type PutEnvelopeRequest
} from "@wireio/opp-typescript-models"

import { DebuggingClient } from "../DebuggingClient.js"
import { DebuggingSubscription } from "../subscriptions/index.js"

/** Caller-facing options for {@link LocalFileDebuggingClient.create}. */
export interface LocalFileDebuggingClientOptions {
  /** Absolute path to the cluster directory. `cluster-config.json` must exist. */
  clusterPath: string
}

/** Fully-resolved runtime config. */
export interface LocalFileDebuggingClientConfig extends Required<LocalFileDebuggingClientOptions> {}

/**
 * Disk-backed `DebuggingClient` for the case where the consumer shares the
 * filesystem with the cluster (the dev-loop scenario). Reads the same files
 * the `external_debugging_plugin` and the harness's process manager write.
 *
 * Streams are implemented via `Fs.watch` (envelope dumps) and timers
 * (process liveness, log tail) — same cadences the TUI used to drive
 * directly before the abstraction landed.
 */
export class LocalFileDebuggingClient extends DebuggingClient {
  /**
   * Validate the cluster path and return a ready-to-use client. Reading
   * files is deferred to the first method call; the only synchronous check
   * here is "does `cluster-config.json` exist?", which fails fast on a
   * misconfigured `--cluster-path` argument.
   */
  static async create(
    options: LocalFileDebuggingClientOptions
  ): Promise<LocalFileDebuggingClient> {
    const config: LocalFileDebuggingClientConfig = {
      clusterPath: Path.resolve(options.clusterPath)
    }
    const configFile = Path.join(
      config.clusterPath,
      ClusterFiles.ConfigFilename
    )
    if (!Fs.existsSync(configFile)) {
      throw new Error(
        `LocalFileDebuggingClient: cluster-config.json not found at ${configFile}`
      )
    }
    return new LocalFileDebuggingClient(config)
  }

  /** Active subscriptions keyed by their client-allocated id. */
  private readonly subscriptions = new Map<number, LocalSubscriptionTeardown>()

  /** Monotonic id allocator for subscriptions. */
  private nextSubscriptionId = LocalFileDebuggingClient.InitialSubscriptionId

  protected constructor(readonly config: LocalFileDebuggingClientConfig) {
    super()
  }

  // -------------------------------------------------------------------------
  //  Lifecycle
  // -------------------------------------------------------------------------

  async connect(): Promise<void> {
    /* no-op for local-disk transport */
  }

  async disconnect(): Promise<void> {
    ;[...this.subscriptions.values()].forEach(teardown => teardown())
    this.subscriptions.clear()
  }

  // -------------------------------------------------------------------------
  //  Cluster
  // -------------------------------------------------------------------------

  async getClusterConfig(): Promise<ClusterConfig> {
    const file = Path.join(
        this.config.clusterPath,
        ClusterFiles.ConfigFilename
      ),
      raw = await Fs.promises.readFile(file, "utf8")
    return ClusterConfigSchemaCodec.deserialize(raw)
  }

  async getClusterState(): Promise<ClusterState> {
    const file = Path.join(this.config.clusterPath, ClusterFiles.StateFilename)
    if (!Fs.existsSync(file)) return null
    const raw = await Fs.promises.readFile(file, "utf8")
    return ClusterStateSchemaCodec.deserialize(raw)
  }

  // -------------------------------------------------------------------------
  //  Process monitor
  // -------------------------------------------------------------------------

  async listProcessSources(): Promise<PidSource[]> {
    const state = await this.getClusterState()
    return collectPidSources(this.config.clusterPath, state)
  }

  async getProcessLiveness(
    labels: string[]
  ): Promise<ProcessLivenessSnapshot[]> {
    const sources = await this.listProcessSources(),
      filtered =
        labels.length === 0
          ? sources
          : sources.filter(s => labels.includes(s.label)),
      now = Date.now()
    return filtered.map(s => snapshotForSource(s, now))
  }

  // -------------------------------------------------------------------------
  //  Logs
  // -------------------------------------------------------------------------

  async getLogStat(path: string): Promise<LogStat> {
    const idx = await buildLineIndex(path)
    return lineIndexToStat(idx)
  }

  async readLogWindow(req: LogReadRequest): Promise<string[]> {
    const idx = await buildLineIndex(req.path)
    return readLines(idx, req.fromLine, req.count)
  }

  // -------------------------------------------------------------------------
  //  OPP envelope debug
  // -------------------------------------------------------------------------

  async listEnvelopes(
    req: ListEnvelopesRequest
  ): Promise<ListEnvelopesResponse> {
    const storageDir = oppDebuggingPath(this.config.clusterPath)
    if (!Fs.existsSync(storageDir)) {
      return ListEnvelopesResponse.create({ entries: [], total: 0 })
    }
    const allFiles = await Fs.promises.readdir(storageDir),
      dataFiles = allFiles
        .filter(f => f.endsWith(LocalFileDebuggingClient.DataExt))
        .sort()
    const resolved = await Promise.all(
      dataFiles.map(dataFile => resolveListEntry(dataFile, storageDir, req))
    )
    const entries = resolved.filter((e): e is EnvelopeListEntry => e !== null)
    return ListEnvelopesResponse.create({ entries, total: entries.length })
  }

  async getEnvelope(key: string): Promise<GetEnvelopeResponse> {
    const storageDir = oppDebuggingPath(this.config.clusterPath),
      dataPath = Path.join(
        storageDir,
        `${key}${LocalFileDebuggingClient.DataExt}`
      ),
      metadataPath = Path.join(
        storageDir,
        `${key}${LocalFileDebuggingClient.MetadataExt}`
      )
    let envelopeData: Uint8Array
    try {
      envelopeData = await Fs.promises.readFile(dataPath)
    } catch (err: any) {
      if (err.code === "ENOENT") {
        throw new NestedError(`Envelope not found: ${key}`, { cause: err })
      }
      throw err
    }
    const { batchOpNames, checksum } = await readMetadataSummary(metadataPath),
      parsed = parseEnvelopeStorageKey(key),
      stat = await Fs.promises.stat(dataPath)
    return {
      key,
      epochIndex: parsed?.epochIndex ?? 0,
      endpointsType: parsed
        ? resolveEndpointsType(parsed.endpointsKey)
        : DebugOutpostEndpointsType.UNKNOWN,
      checksum,
      batchOpNames,
      timestamp: BigInt(Math.floor(stat.mtimeMs)),
      dataSize: envelopeData.length,
      envelopeData: Buffer.from(envelopeData)
    }
  }

  async loadEnvelopeRecords(
    req: LoadEnvelopeRecordsRequest
  ): Promise<LoadEnvelopeRecordsResponse> {
    const records = await readEnvelopeRecordsFromDir(
      oppDebuggingPath(this.config.clusterPath),
      {
        epochStart: req.epochStart,
        epochEnd: req.epochEnd,
        endpointsType: req.endpointsType
      }
    )
    return { records }
  }

  /**
   * Helper used by harness/test code to seed the local OPP debugging dir.
   * The standard write path is the sysio plugin; this method exists so unit
   * tests and the in-process server fixture can produce envelopes through
   * the same disk-key shape without re-implementing the storage geometry.
   */
  async putEnvelope(req: PutEnvelopeRequest): Promise<PutEnvelopeResponse> {
    const storageDir = oppDebuggingPath(this.config.clusterPath)
    await Fs.promises.mkdir(storageDir, { recursive: true })
    // `envelopeData` is typed `Uint8Array` by the generated proto message, but
    // a request arriving over the NetDebuggingClient's JSON transport carries
    // it as a base64 string (JSON has no binary type). Widen to the honest
    // runtime union at the boundary (plain assignment — no cast) and branch
    // with a compiler-native `typeof` guard: ts-pattern's `P.string` mis-infers
    // this arm against TS 6's generic `Uint8Array<ArrayBufferLike>` builtin.
    const envelopeData: Uint8Array | string = req.envelopeData
    const envelopeBytes =
        typeof envelopeData === "string"
          ? Buffer.from(envelopeData, "base64")
          : Buffer.from(envelopeData),
      checksum = createHash("sha256")
        .update(envelopeBytes)
        .digest("hex")
        .substring(0, LocalFileDebuggingClient.ChecksumHexChars),
      envelope = Envelope.fromBinary(envelopeBytes),
      epochIndex = String(envelope.epochIndex).padStart(
        LocalFileDebuggingClient.EpochIndexPadWidth,
        "0"
      ),
      endpointsKey = endpointsTypeToKey(req.endpointsType),
      baseKey = `${epochIndex}-${endpointsKey}-${checksum}`,
      dataFile = Path.join(
        storageDir,
        `${baseKey}${LocalFileDebuggingClient.DataExt}`
      ),
      metadataFile = Path.join(
        storageDir,
        `${baseKey}${LocalFileDebuggingClient.MetadataExt}`
      )
    let dataExisted = false
    try {
      await Fs.promises.writeFile(dataFile, envelopeBytes, { flag: "wx" })
    } catch (err: any) {
      if (err.code === "EEXIST") {
        dataExisted = true
      } else {
        throw err
      }
    }
    const metadata = await readOrInitMetadata(
      metadataFile,
      checksum,
      req.batchOpName
    )
    await Fs.promises.writeFile(
      metadataFile,
      DebugEnvelopeMetadataRecord.toBinary(metadata)
    )
    return PutEnvelopeResponse.create({
      key: baseKey,
      dataExisted,
      batchOpNames: metadata.batchOpNames
    })
  }

  // -------------------------------------------------------------------------
  //  Streams
  // -------------------------------------------------------------------------

  async subscribe<T extends StreamTopic>(
    topic: T,
    params: InferredStreamParams<T>
  ): Promise<DebuggingSubscription<InferredStreamEvent<T>>> {
    const id = this.nextSubscriptionId++,
      sub = new DebuggingSubscription<InferredStreamEvent<T>>(id, topic, () => {
        const teardown = this.subscriptions.get(id)
        this.subscriptions.delete(id)
        teardown?.()
      })
    // One unavoidable cast per arm, at this facade's dispatch point (per
    // `one-generic-facade-per-concept.md`): TS cannot correlate the generic
    // `T` narrowed by `match(topic)` with `InferredStreamEvent<T>` resolving
    // to the arm's concrete event type.
    const teardown = await match(topic as StreamTopic)
      .with(StreamTopic.LogTail, () =>
        this.startLogTail(
          sub as DebuggingSubscription<LogTailEvent>,
          params as LogTailParams
        )
      )
      .with(StreamTopic.ProcessLiveness, () =>
        this.startProcessLiveness(
          sub as DebuggingSubscription<ProcessLivenessEvent>
        )
      )
      .with(StreamTopic.EnvelopeWatch, () =>
        this.startEnvelopeWatch(sub as DebuggingSubscription<EnvelopeEvent>)
      )
      .exhaustive()
    this.subscriptions.set(id, teardown)
    return sub
  }

  // -------------------------------------------------------------------------
  //  Stream implementations (private)
  // -------------------------------------------------------------------------

  private async startLogTail(
    sub: DebuggingSubscription<LogTailEvent>,
    params: LogTailParams
  ): Promise<LocalSubscriptionTeardown> {
    let index: LineIndex | null = null,
      stopped = false
    try {
      index = await buildLineIndex(params.path)
    } catch {
      // File missing right now — start with no index; tick() will retry.
    }
    const tick = async () => {
      if (stopped) return
      try {
        const next = index
          ? await extendLineIndex(index)
          : await buildLineIndex(params.path)
        if (
          index &&
          next.totalBytes === index.totalBytes &&
          next.ino === index.ino
        ) {
          return
        }
        const fromLine = index?.completeLineCount ?? 0,
          appendedCount = next.completeLineCount - fromLine,
          lines =
            appendedCount > 0
              ? await readLines(next, fromLine, appendedCount)
              : []
        index = next
        sub.emitEvent({
          path: params.path,
          appendedFromLine: fromLine,
          lines,
          totalBytes: next.totalBytes,
          totalLines: next.completeLineCount,
          ino: next.ino
        })
      } catch {
        /* transient; try again on next tick */
      }
    }
    await tick()
    const timer = setInterval(
      () => void tick(),
      LocalFileDebuggingClient.LogTailPollMs
    )
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }

  private async startProcessLiveness(
    sub: DebuggingSubscription<ProcessLivenessEvent>
  ): Promise<LocalSubscriptionTeardown> {
    let prev = new Map<string, ProcessLivenessSnapshot>(),
      stopped = false
    const tick = async () => {
      if (stopped) return
      const sources = await this.listProcessSources(),
        now = Date.now(),
        next = new Map<string, ProcessLivenessSnapshot>()
      sources.forEach(src => {
        const baseline = snapshotForSource(src, now),
          previous = prev.get(src.label),
          exitedAt = computeExitedAt(baseline, previous, now)
        next.set(src.label, { ...baseline, exitedAt })
      })
      const setSnapshots: ProcessLivenessSnapshot[] = [],
        seen = new Set<string>(next.keys())
      next.forEach((snap, label) => {
        const prior = prev.get(label)
        if (
          !prior ||
          prior.pid !== snap.pid ||
          prior.alive !== snap.alive ||
          prior.exitedAt !== snap.exitedAt
        ) {
          setSnapshots.push(snap)
        }
      })
      const removedLabels = [...prev.keys()].filter(label => !seen.has(label))
      prev = next
      if (setSnapshots.length > 0 || removedLabels.length > 0) {
        sub.emitEvent({ setSnapshots, removedLabels })
      }
    }
    await tick()
    const timer = setInterval(
      () => void tick(),
      LocalFileDebuggingClient.ProcessLivenessPollMs
    )
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }

  private async startEnvelopeWatch(
    sub: DebuggingSubscription<EnvelopeEvent>
  ): Promise<LocalSubscriptionTeardown> {
    const storageDir = oppDebuggingPath(this.config.clusterPath)
    await Fs.promises.mkdir(storageDir, { recursive: true })
    const seen = new Set<string>()
    const watcher = Fs.watch(
      storageDir,
      { persistent: true },
      (_evt, filename) => {
        if (!filename) return
        void this.tryEmitFromFilename(
          sub,
          storageDir,
          filename.toString(),
          seen,
          /* hydrating */ false
        )
      }
    )
    // Defer the initial hydrate dump to the next tick so consumers who
    // register listeners immediately after `await subscribe(...)` returns
    // still catch every replayed event.
    const hydrate = async (): Promise<void> => {
      const existing = await Fs.promises.readdir(storageDir),
        baseKeys = existing
          .filter(f => f.endsWith(LocalFileDebuggingClient.MetadataExt))
          .map(f => f.slice(0, -LocalFileDebuggingClient.MetadataExt.length))
      await Bluebird.each(baseKeys, async baseKey => {
        if (sub.isClosed()) return
        const pair = await this.readEnvelopePair(storageDir, baseKey)
        if (!pair) return
        seen.add(baseKey)
        sub.emitEvent({
          kind: EnvelopeEventKind.Hydrated,
          epoch: pair.epoch,
          record: pair.record
        })
      })
    }
    setImmediate(() => void hydrate())
    return () => {
      try {
        watcher.close()
      } catch {
        /* ignore */
      }
    }
  }

  private async tryEmitFromFilename(
    sub: DebuggingSubscription<EnvelopeEvent>,
    storageDir: string,
    filename: string,
    seen: Set<string>,
    hydrating: boolean
  ): Promise<void> {
    if (!filename.endsWith(LocalFileDebuggingClient.MetadataExt)) return
    const baseKey = filename.slice(
      0,
      -LocalFileDebuggingClient.MetadataExt.length
    )
    if (seen.has(baseKey)) return
    const pair = await this.readEnvelopePair(storageDir, baseKey)
    if (!pair) return
    seen.add(baseKey)
    sub.emitEvent({
      kind: hydrating ? EnvelopeEventKind.Hydrated : EnvelopeEventKind.Added,
      epoch: pair.epoch,
      record: pair.record
    })
  }

  /** Read + decode `.data` + `.metadata` pair; null when either file is missing/malformed. */
  private async readEnvelopePair(
    storageDir: string,
    baseKey: string
  ): Promise<LocalFileDebuggingClient.EnvelopeRecordPair> {
    const parsed = parseEnvelopeStorageKey(baseKey)
    if (!parsed) return null
    const dataPath = Path.join(
        storageDir,
        baseKey + LocalFileDebuggingClient.DataExt
      ),
      metaPath = Path.join(
        storageDir,
        baseKey + LocalFileDebuggingClient.MetadataExt
      )
    try {
      const [dataBytes, metaBytes] = await Promise.all([
        Fs.promises.readFile(dataPath),
        Fs.promises.readFile(metaPath)
      ])
      return {
        epoch: parsed.epochIndex,
        record: {
          checksum: parsed.checksum,
          endpointsType: resolveEndpointsType(parsed.endpointsKey),
          envelope: plainify(Envelope.fromBinary(dataBytes)),
          metadata: plainify(DebugEnvelopeMetadataRecord.fromBinary(metaBytes)),
          receivedAt: Date.now()
        }
      }
    } catch {
      return null
    }
  }
}

export namespace LocalFileDebuggingClient {
  /** Initial subscription id. Monotonic counter — value isn't load-bearing. */
  export const InitialSubscriptionId = 1
  /** File-growth poll interval for `LogTail`, ms. */
  export const LogTailPollMs = 200
  /** Process-liveness poll interval, ms. Mirrors prior TUI cadence. */
  export const ProcessLivenessPollMs = 5_000
  /** Envelope `.data` file extension. */
  export const DataExt = ".data" as const
  /** Envelope `.metadata` file extension. */
  export const MetadataExt = ".metadata" as const
  /** sha256 hex chars retained in storage keys + `EnvelopeListEntry.checksum`. */
  export const ChecksumHexChars = 16
  /** Hex chars packed into the `DebugEnvelopeMetadataRecord.checksum` u64. */
  export const MetadataChecksumHexChars = 12
  /** Zero-pad width applied to `epoch_index` when forming storage keys. */
  export const EpochIndexPadWidth = 8

  /** Decoded `.data` + `.metadata` pair for one stored envelope. */
  export interface EnvelopeRecordPair {
    epoch: number
    record: DebugOPPEnvelopeRecord
  }

  /** Result of appending to (or freshly initializing) a metadata record. */
  export interface MetadataUpdateResult {
    checksum: bigint
    batchOpNames: string[]
  }

  /** `batchOpNames` + hex `checksum` read from a metadata file. */
  export interface MetadataSummary {
    batchOpNames: string[]
    checksum: string
  }
}

// ---------------------------------------------------------------------------
//  Internal helpers
// ---------------------------------------------------------------------------

/** Teardown thunk returned by stream-startup methods. */
type LocalSubscriptionTeardown = () => void

/** Snapshot a single source's pid + liveness; `exitedAt` resolved separately. */
function snapshotForSource(
  source: PidSource,
  now: number
): ProcessLivenessSnapshot {
  const pid = readPid(source.pidPath),
    alive = pidIsAlive(pid)
  return {
    label: source.label,
    pid,
    alive,
    lastCheckedAt: now,
    exitedAt: alive ? null : now
  }
}

/** Decide the `exitedAt` field given current + prior snapshots. */
function computeExitedAt(
  current: ProcessLivenessSnapshot,
  prior: ProcessLivenessSnapshot | undefined,
  now: number
): number {
  return match({ alive: current.alive, prev: prior })
    .with({ alive: true }, () => null)
    .with({ alive: false, prev: { alive: true } }, () => now)
    .otherwise(({ prev }) => prev?.exitedAt ?? null) as number | null
}

/** Convert a `LineIndex` snapshot into the wire-friendly `LogStat`. */
function lineIndexToStat(index: LineIndex): LogStat {
  return {
    path: index.path,
    ino: index.ino,
    totalBytes: index.totalBytes,
    totalLines: index.completeLineCount
  }
}

/** Resolve a single `.data` filename into a populated `EnvelopeListEntry`. */
async function resolveListEntry(
  dataFile: string,
  storageDir: string,
  filter: ListEnvelopesRequest
): Promise<EnvelopeListEntry> {
  const parsed = parseEnvelopeStorageKey(
    dataFile.replace(LocalFileDebuggingClient.DataExt, "")
  )
  if (!parsed) return null
  if (filter.epochStart > 0 && parsed.epochIndex < filter.epochStart)
    return null
  if (filter.epochEnd > 0 && parsed.epochIndex > filter.epochEnd) return null
  if (filter.endpointsType !== DebugOutpostEndpointsType.UNKNOWN) {
    const filterKey = endpointsTypeToKey(filter.endpointsType)
    if (filterKey && parsed.endpointsKey !== filterKey) return null
  }
  const dataPath = Path.join(storageDir, dataFile),
    metadataPath = Path.join(
      storageDir,
      dataFile.replace(
        LocalFileDebuggingClient.DataExt,
        LocalFileDebuggingClient.MetadataExt
      )
    ),
    stat = await Fs.promises.stat(dataPath),
    timestampMs = stat.mtimeMs
  if (
    Number(filter.timestampStart) > 0 &&
    timestampMs < Number(filter.timestampStart)
  )
    return null
  if (
    Number(filter.timestampEnd) > 0 &&
    timestampMs > Number(filter.timestampEnd)
  )
    return null
  const batchOpNames = await readMetadataBatchOpNames(metadataPath)
  return EnvelopeListEntry.create({
    key: parsed.key,
    epochIndex: parsed.epochIndex,
    endpointsType: resolveEndpointsType(parsed.endpointsKey),
    checksum: parsed.checksum,
    batchOpNames,
    timestamp: BigInt(Math.floor(timestampMs)),
    dataSize: stat.size
  })
}

/** Append `batchOpName` into an existing metadata file or initialize a new one. */
async function readOrInitMetadata(
  metadataFile: string,
  checksum: string,
  batchOpName: string
): Promise<LocalFileDebuggingClient.MetadataUpdateResult> {
  try {
    const existingBytes = await Fs.promises.readFile(metadataFile),
      decoded = DebugEnvelopeMetadataRecord.fromBinary(existingBytes),
      batchOpNames = [...decoded.batchOpNames]
    if (!batchOpNames.includes(batchOpName)) batchOpNames.push(batchOpName)
    return { checksum: decoded.checksum, batchOpNames }
  } catch {
    return {
      checksum: BigInt(
        `0x${checksum.substring(0, LocalFileDebuggingClient.MetadataChecksumHexChars)}`
      ),
      batchOpNames: [batchOpName]
    }
  }
}

/** Read just `batchOpNames` from a metadata file. */
async function readMetadataBatchOpNames(
  metadataPath: string
): Promise<string[]> {
  try {
    const metaBytes = await Fs.promises.readFile(metadataPath)
    return [...DebugEnvelopeMetadataRecord.fromBinary(metaBytes).batchOpNames]
  } catch {
    return []
  }
}

/** Read both `batchOpNames` and the hex checksum from a metadata file. */
async function readMetadataSummary(
  metadataPath: string
): Promise<LocalFileDebuggingClient.MetadataSummary> {
  try {
    const metaBytes = await Fs.promises.readFile(metadataPath),
      meta = DebugEnvelopeMetadataRecord.fromBinary(metaBytes)
    return {
      batchOpNames: [...meta.batchOpNames],
      checksum: meta.checksum.toString(16)
    }
  } catch {
    return { batchOpNames: [], checksum: "" }
  }
}
