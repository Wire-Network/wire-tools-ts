import Crypto from "node:crypto"
import Fs from "node:fs"
import Path from "node:path"

import { Either } from "@3fv/prelude-ts"
import { defaults, identity } from "lodash"

import type { SchemaCodec } from "@wireio/cluster-tool-shared"
import { getLogger, NestedError } from "@wireio/shared"

const log = getLogger(__filename)

/** Options of a {@link JsonDocumentStore}. */
export interface JsonDocumentStoreOptions<T> {
  /** The document file. */
  file: string
  /** Validating codec of the document. */
  codec: SchemaCodec<T>
  /** The document of a missing file. */
  createEmpty: () => T
  /** Coalescing window of change notifications (ms). */
  watchDebounceMs?: number
}

/** Resolved store options. */
export interface JsonDocumentStoreConfig<T> extends Required<JsonDocumentStoreOptions<T>> {}

/**
 * Defaults for {@link JsonDocumentStoreOptions} (the members that have one).
 *
 * @returns The default options.
 */
export function createJsonDocumentStoreDefaultOptions<T>(): Partial<JsonDocumentStoreOptions<T>> {
  return { watchDebounceMs: JsonDocumentStore.DefaultWatchDebounceMs }
}

/** Unsubscribes a watch. */
export type JsonDocumentUnwatch = () => void

/**
 * One JSON document on disk behind a {@link SchemaCodec}: validated reads,
 * atomic temp+rename writes (last writer wins), and `fs.watch` change
 * notification. The ONE implementation behind profiles and saved queries.
 */
export class JsonDocumentStore<T> {
  /** Resolved options. */
  readonly config: JsonDocumentStoreConfig<T>

  /**
   * @param options - File, codec, empty document and debounce.
   */
  constructor(options: JsonDocumentStoreOptions<T>) {
    this.config = defaults({ ...options }, createJsonDocumentStoreDefaultOptions<T>()) as JsonDocumentStoreConfig<T>
  }

  /**
   * The current document (the empty document when the file is missing).
   *
   * @returns The validated document.
   * @throws NestedError when the file holds an invalid document.
   */
  read(): T {
    const { file, codec, createEmpty } = this.config
    return Fs.existsSync(file) ? codec.deserialize(Fs.readFileSync(file)) : createEmpty()
  }

  /**
   * The current document, or the empty document when the file holds an invalid
   * one (logged as a warning with the error — the file is left as it is until
   * the next write replaces it).
   *
   * @returns The validated document, or the empty document.
   */
  readOrEmpty(): T {
    return Either.try(() => this.read()).match({
      Left: error => {
        log.warn(`ignoring unreadable ${this.config.file}: ${NestedError.toError(error).message}`, error)
        return this.config.createEmpty()
      },
      Right: identity
    })
  }

  /**
   * Replace the document atomically (temp file in the same directory, then rename).
   *
   * @param document - The new document (validated by the codec).
   */
  write(document: T): void {
    const { file, codec } = this.config,
      text = codec.serialize(document),
      temporary = `${file}.${process.pid}.${Crypto.randomUUID()}${JsonDocumentStore.TemporarySuffix}`
    Fs.mkdirSync(Path.dirname(file), { recursive: true })
    Fs.writeFileSync(temporary, `${text}\n`)
    Fs.renameSync(temporary, file)
  }

  /**
   * Read → transform → write.
   *
   * @param transform - Produces the new document from the current one.
   * @returns The written document.
   */
  update(transform: (document: T) => T): T {
    const next = transform(this.read())
    this.write(next)
    return next
  }

  /**
   * Notify `listener` with the re-read document whenever the file changes
   * (another instance's write included). Watches the directory, because an
   * atomic rename replaces the file's inode. A watcher error is logged and
   * ends notification without crashing the process.
   *
   * @param listener - Receives the new document.
   * @returns Unsubscribe.
   */
  watch(listener: (document: T) => void): JsonDocumentUnwatch {
    const { file, watchDebounceMs } = this.config,
      directory = Path.dirname(file),
      name = Path.basename(file)
    Fs.mkdirSync(directory, { recursive: true })
    let pending: ReturnType<typeof setTimeout> = null
    const deliver = () => {
        pending = null
        try {
          listener(this.read())
        } catch (error) {
          log.warn(`reloading ${file} failed: ${NestedError.toError(error).message}`)
        }
      },
      watcher = Fs.watch(directory, (_event, changed) => {
        if (changed !== name) return
        if (pending != null) clearTimeout(pending)
        pending = setTimeout(deliver, watchDebounceMs)
      })
    // An unhandled 'error' (the directory removed, a watch limit hit) would
    // crash the process; log it and keep running — the store still reads and
    // writes, only change notification stops.
    watcher.on(JsonDocumentStore.WatchErrorEvent, error =>
      log.warn(`watching ${directory} for ${name} failed: ${error.message}`)
    )
    return () => {
      if (pending != null) clearTimeout(pending)
      watcher.close()
    }
  }
}

/** Store constants. */
export namespace JsonDocumentStore {
  /** Default change-notification debounce. */
  export const DefaultWatchDebounceMs = 50
  /** Suffix of in-flight temp files. */
  export const TemporarySuffix = ".tmp"
  /** The `fs.FSWatcher` event carrying a watch failure. */
  export const WatchErrorEvent = "error"
}
