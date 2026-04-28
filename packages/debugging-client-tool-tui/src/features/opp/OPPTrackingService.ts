import Fs from "node:fs"
import Path from "node:path"
import Bluebird from "bluebird"
import { asOption } from "@3fv/prelude-ts"
import {
  DebugEnvelopeMetadataRecord,
  DebugOutpostEndpointsType,
  Envelope
} from "@wireio/opp-typescript-models"
import { LoggingManager } from "../../logging/LoggingManager.js"
import { ServiceId } from "../../services/ServiceId.js"
import { ReduxService } from "../../services/ReduxService.js"
import type { Service } from "../../services/Service.js"
import type { ServiceManager } from "../../services/ServiceManager.js"
import {
  appendEnvelope,
  hydrate
} from "../../store/opp/OPPSlice.js"
import type {
  DebugOPPEnvelopeRecord,
  DebugOPPEpochRecord
} from "../../store/opp/OPPTypes.js"
import { selectCluster } from "../../store/cluster/ClusterSelectors.js"

/**
 * Watches `<clusterPath>/data/opp-debugging/` for new envelope+metadata pairs.
 *
 * The debugging server writes `.data` first (exclusive `wx` flag) and then
 * `.metadata`. Keying on `.metadata` events guarantees we never process a
 * half-written pair — no debounce needed.
 *
 * On `start()`:
 *   1. Open the watcher (events buffered).
 *   2. Scan existing files, dispatch one `hydrate(records)` action.
 *   3. Drain buffered events, deduping against the seen set.
 */
export class OPPTrackingService implements Service {
  static readonly id = ServiceId.OPPTracking
  static readonly dependsOn: readonly string[] = [ServiceId.Redux]

  private readonly log = LoggingManager.getLogger(OPPTrackingService.Category)
  private watcher: Fs.FSWatcher | null = null
  private storageDir: string | null = null
  private readonly pendingEvents = new Set<string>()
  private readonly seen = new Set<string>()
  private hydrating = false
  private redux: ReduxService | null = null

  async init(manager: ServiceManager): Promise<this> {
    this.redux = manager.get<ReduxService>(ServiceId.Redux)
    const cluster = selectCluster(this.redux.getState())
    asOption(cluster.path).match({
      None: () =>
        this.log.warn("No cluster path loaded; OPPTrackingService inactive"),
      Some: path => {
        this.storageDir = Path.join(path, OPPTrackingService.StorageSubpath)
        Fs.mkdirSync(this.storageDir, { recursive: true })
      }
    })
    return this
  }

  async start(_manager: ServiceManager): Promise<this> {
    if (!this.storageDir || !this.redux) return this
    this.hydrating = true
    this.watcher = Fs.watch(
      this.storageDir,
      { persistent: true },
      (_evt, filename) => {
        if (!filename) return
        if (this.hydrating) this.pendingEvents.add(filename)
        else void this.tryProcess(filename)
      }
    )
    await this.hydrateFromDisk()
    this.hydrating = false
    const buffered = [...this.pendingEvents]
    this.pendingEvents.clear()
    await Bluebird.each(buffered, f => this.tryProcess(f))
    this.log.info(
      `OPPTrackingService started; watching ${this.storageDir}`
    )
    return this
  }

  async stop(_manager: ServiceManager): Promise<this> {
    try {
      this.watcher?.close()
    } catch (err) {
      this.log.error("watcher close failed", err)
    }
    this.watcher = null
    return this
  }

  /** Scan every pre-existing metadata file; bulk-dispatch as one `hydrate` action. */
  private async hydrateFromDisk(): Promise<void> {
    if (!this.storageDir || !this.redux) return
    const existing = await Fs.promises.readdir(this.storageDir),
      baseKeys = existing
        .filter(f => f.endsWith(OPPTrackingService.MetadataExt))
        .map(f => f.slice(0, -OPPTrackingService.MetadataExt.length)),
      byEpoch = new Map<number, DebugOPPEnvelopeRecord[]>()
    await Bluebird.each(baseKeys, async baseKey => {
      const pair = await this.readPair(baseKey)
      asOption(pair).ifSome(p => {
        const arr = byEpoch.get(p.epoch) ?? []
        arr.push(p.record)
        byEpoch.set(p.epoch, arr)
        this.seen.add(baseKey)
      })
    })
    const records: DebugOPPEpochRecord[] = [...byEpoch.entries()].map(
      ([epoch, envelopes]) => ({ epoch, envelopes })
    )
    if (records.length > 0) this.redux.dispatch(hydrate(records))
  }

  /** Process one fs event; no-op unless the filename is a `.metadata` write we haven't seen. */
  private async tryProcess(filename: string): Promise<void> {
    if (!filename.endsWith(OPPTrackingService.MetadataExt)) return
    const baseKey = filename.slice(0, -OPPTrackingService.MetadataExt.length)
    if (this.seen.has(baseKey)) return
    const pair = await this.readPair(baseKey)
    asOption(pair).ifSome(p => {
      this.seen.add(baseKey)
      this.redux?.dispatch(
        appendEnvelope({ epoch: p.epoch, record: p.record })
      )
    })
  }

  /** Read + decode `.data` + `.metadata` pair; null when either file is missing/malformed. */
  private async readPair(
    baseKey: string
  ): Promise<{ epoch: number; record: DebugOPPEnvelopeRecord } | null> {
    if (!this.storageDir) return null
    const parsed = parseStorageKey(baseKey)
    if (!parsed) return null
    const dataPath = Path.join(
        this.storageDir,
        baseKey + OPPTrackingService.DataExt
      ),
      metaPath = Path.join(
        this.storageDir,
        baseKey + OPPTrackingService.MetadataExt
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
    } catch (err) {
      this.log.debug(`readPair(${baseKey}) failed; likely transient`, err)
      return null
    }
  }
}

export namespace OPPTrackingService {
  /** Log category. */
  export const Category = "tui:opp-tracking" as const
  /** Subpath under `<clusterPath>` where the server persists envelopes. */
  export const StorageSubpath = "data/opp-debugging" as const
  export const DataExt = ".data" as const
  export const MetadataExt = ".metadata" as const
}

/** Parsed envelope storage key. Mirrors server — see `debugging-server/src/routes/opp/OPPRoutes.ts`. */
interface ParsedStorageKey {
  key: string
  epochIndex: number
  endpointsKey: string
  checksum: string
}

/** Split `<epoch>-<endpointsKey>-<checksum>` into its components; null on malformed. */
function parseStorageKey(key: string): ParsedStorageKey | null {
  const firstDash = key.indexOf("-"),
    lastDash = key.lastIndexOf("-")
  if (firstDash < 0 || lastDash <= firstDash) return null
  const epochIndex = parseInt(key.substring(0, firstDash), 10)
  if (isNaN(epochIndex)) return null
  return {
    key,
    epochIndex,
    endpointsKey: key.substring(firstDash + 1, lastDash),
    checksum: key.substring(lastDash + 1)
  }
}

/** Reverse-map an enum name to its numeric variant; UNKNOWN fallback on mismatch. */
function resolveEndpointsType(endpointsKey: string): DebugOutpostEndpointsType {
  return asOption(
    (DebugOutpostEndpointsType as Record<string, unknown>)[endpointsKey]
  )
    .filter((v): v is number => typeof v === "number")
    .map(v => v as DebugOutpostEndpointsType)
    .getOrElse(DebugOutpostEndpointsType.UNKNOWN)
}

/**
 * Convert a freshly-decoded protobuf message into Redux-serializable shape:
 * BigInts become decimal strings; Uint8Arrays become base64. Recursive walk
 * rather than a `JSON.stringify` replacer because `Buffer.prototype.toJSON`
 * fires BEFORE the replacer and converts a `Buffer` into
 * `{ type: "Buffer", data: number[] }` — which would then never match the
 * Uint8Array check. Walking the tree directly catches every Uint8Array
 * (including any `Buffer` subclass instances protobuf-ts may surface).
 */
function plainify<T>(value: T): T {
  return walk(value) as T
}

function walk(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === "bigint") return value.toString()
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64")
  if (Array.isArray(value)) return value.map(walk)
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        walk(v)
      ])
    )
  }
  return value
}
