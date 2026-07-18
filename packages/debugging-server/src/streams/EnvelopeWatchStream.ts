import * as Fs from "node:fs"
import * as Path from "node:path"

import Bluebird from "bluebird"
import {
  EnvelopeEventKind,
  oppDebuggingPath,
  parseEnvelopeStorageKey,
  plainify,
  resolveEndpointsType,
  type DebugOPPEnvelopeRecord,
  type EnvelopeEvent
} from "@wireio/debugging-shared"
import {
  DebugEnvelopeMetadataRecord,
  Envelope
} from "@wireio/opp-typescript-models"

import { log } from "../logging/index.js"

import type { ServerSideStream } from "./ServerSideStream.js"

/**
 * Server-side envelope-watch stream. On `start()` enumerates every
 * existing `<key>.metadata` pair and fires a `Hydrated` event per pair,
 * then `Fs.watch` the directory and fires `Added` on every new pair.
 */
export class EnvelopeWatchStream implements ServerSideStream<EnvelopeEvent> {
  private watcher: Fs.FSWatcher | null = null
  private readonly seen = new Set<string>()
  private readonly storageDir: string
  private stopped = false

  /**
   * @param clusterPath Cluster root; storage dir resolves to
   *                    `<clusterPath>/data/opp-debugging`.
   */
  constructor(clusterPath: string) {
    this.storageDir = oppDebuggingPath(clusterPath)
  }

  async start(emit: (payload: EnvelopeEvent) => void): Promise<void> {
    await Fs.promises.mkdir(this.storageDir, { recursive: true })
    this.watcher = Fs.watch(
      this.storageDir,
      { persistent: true },
      (_evt, filename) => {
        if (!filename || this.stopped) return
        void this.tryEmit(filename.toString(), false, emit)
      }
    )
    // Hydrate scheduled to next tick so consumer's WS pipe is ready.
    setImmediate(() => void this.hydrate(emit))
  }

  async stop(): Promise<void> {
    this.stopped = true
    try {
      this.watcher?.close()
    } catch {
      /* ignore */
    }
    this.watcher = null
    this.seen.clear()
  }

  private async hydrate(emit: (payload: EnvelopeEvent) => void): Promise<void> {
    if (this.stopped) return
    const existing = await Fs.promises.readdir(this.storageDir),
      baseKeys = existing
        .filter(f => f.endsWith(EnvelopeWatchStream.MetadataExt))
        .map(f => f.slice(0, -EnvelopeWatchStream.MetadataExt.length))
    await Bluebird.each(baseKeys, async baseKey => {
      if (this.stopped) return
      await this.tryEmitBaseKey(baseKey, true, emit)
    })
  }

  private async tryEmit(
    filename: string,
    hydrating: boolean,
    emit: (payload: EnvelopeEvent) => void
  ): Promise<void> {
    if (!filename.endsWith(EnvelopeWatchStream.MetadataExt)) return
    const baseKey = filename.slice(0, -EnvelopeWatchStream.MetadataExt.length)
    await this.tryEmitBaseKey(baseKey, hydrating, emit)
  }

  private async tryEmitBaseKey(
    baseKey: string,
    hydrating: boolean,
    emit: (payload: EnvelopeEvent) => void
  ): Promise<void> {
    if (this.seen.has(baseKey)) return
    const pair = await this.readPair(baseKey)
    if (!pair) return
    this.seen.add(baseKey)
    emit({
      kind: hydrating ? EnvelopeEventKind.Hydrated : EnvelopeEventKind.Added,
      epoch: pair.epoch,
      record: pair.record
    })
  }

  private async readPair(
    baseKey: string
  ): Promise<{ epoch: number; record: DebugOPPEnvelopeRecord } | null> {
    const parsed = parseEnvelopeStorageKey(baseKey)
    if (!parsed) return null
    const dataPath = Path.join(
        this.storageDir,
        baseKey + EnvelopeWatchStream.DataExt
      ),
      metaPath = Path.join(
        this.storageDir,
        baseKey + EnvelopeWatchStream.MetadataExt
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
      log.debug(`EnvelopeWatchStream readPair(${baseKey}) failed`, err)
      return null
    }
  }
}

export namespace EnvelopeWatchStream {
  /** Envelope `.data` file extension. */
  export const DataExt = ".data" as const
  /** Envelope `.metadata` file extension. */
  export const MetadataExt = ".metadata" as const
}
