import Fs from "node:fs"
import Path from "node:path"

import { Either } from "@3fv/prelude-ts"
import { defaults, identity } from "lodash"

import { getLogger } from "@wireio/shared"

import { QueryHistoryEntryCodec, type QueryHistoryEntry } from "../profiles/index.js"
import { QLPaths } from "./QLPaths.js"

const log = getLogger(__filename)

/** Store options (all optional). */
export interface QueryHistoryStoreOptions {
  /** The log (default {@link QLPaths.historyFile}). */
  file?: string
  /** Bytes read per backward tail chunk (default {@link QueryHistoryStore.TailChunkBytes}). */
  tailChunkBytes?: number
}

/** Resolved store options. */
export interface QueryHistoryStoreConfig extends Required<QueryHistoryStoreOptions> {}

/**
 * Defaults for {@link QueryHistoryStoreOptions}.
 *
 * @returns The default options.
 */
export function createQueryHistoryStoreDefaultOptions(): Partial<QueryHistoryStoreOptions> {
  return { file: QLPaths.historyFile(), tailChunkBytes: QueryHistoryStore.TailChunkBytes }
}

/** History listing options (all optional). */
export interface QueryHistoryListOptions {
  /** Newest entries to return (default {@link QueryHistoryStore.DefaultListLimit}). */
  limit?: number
  /** Case-insensitive substring the query text must contain. */
  search?: string
}

/** Resolved listing options. */
export interface QueryHistoryListConfig extends Required<QueryHistoryListOptions> {}

/**
 * Defaults for {@link QueryHistoryListOptions}.
 *
 * @returns The default options.
 */
export function createQueryHistoryListDefaultOptions(): Partial<QueryHistoryListOptions> {
  return { limit: QueryHistoryStore.DefaultListLimit, search: "" }
}

/** One backward-read chunk of the history tail. */
interface TailChunk {
  /** Complete lines found so far (oldest first), still undecoded bytes. */
  lines: Buffer[]
  /** Bytes of a partial first line carried to the next (earlier) chunk. */
  carry: Buffer
  /** Read position (bytes from file start) of the next earlier chunk. */
  position: number
}

/**
 * `history.jsonl`: one compact JSON line per record, each written by ONE
 * `write(2)` on an `O_APPEND` descriptor, so the kernel positions every write
 * at the current end of file atomically and concurrent appenders never
 * overwrite each other (the regular-file guarantee; PIPE_BUF bounds only
 * pipes/FIFOs). Never compacted. Listing reads the file TAIL backwards in
 * chunks, splitting on the newline BYTE so a multi-byte character straddling a
 * chunk boundary is decoded only once its line is complete. `clear` truncates
 * (an append racing it may survive).
 */
export class QueryHistoryStore {
  /** Resolved options. */
  readonly config: QueryHistoryStoreConfig

  /**
   * @param options - Log file and tail chunk size.
   */
  constructor(options: QueryHistoryStoreOptions = {}) {
    this.config = defaults({ ...options }, createQueryHistoryStoreDefaultOptions()) as QueryHistoryStoreConfig
  }

  /** The log file. */
  get file(): string {
    return this.config.file
  }

  /**
   * Append one record.
   *
   * @param entry - The record (validated).
   */
  append(entry: QueryHistoryEntry): void {
    const line = `${QueryHistoryEntryCodec.serializeCompact(entry)}${QueryHistoryStore.LineSeparator}`
    Fs.mkdirSync(Path.dirname(this.file), { recursive: true })
    Fs.appendFileSync(this.file, line, { flag: QueryHistoryStore.AppendFlag })
  }

  /**
   * Newest-first records, optionally filtered by query text.
   *
   * @param options - Limit and search.
   * @returns Records, newest first.
   */
  list(options: QueryHistoryListOptions = {}): QueryHistoryEntry[] {
    const config = defaults({ ...options }, createQueryHistoryListDefaultOptions()) as QueryHistoryListConfig,
      needle = config.search.toLowerCase()
    return this.scan(entry => entry.query.toLowerCase().includes(needle), config.limit)
  }

  /**
   * The record with `id` (the newest when several share it), read from the tail
   * until it is found.
   *
   * @param id - The record id.
   * @returns The record, or undefined when no record has that id.
   */
  get(id: string): QueryHistoryEntry {
    return this.scan(entry => entry.id === id, 1)[0]
  }

  /** Truncate the log (racing appends may survive). */
  clear(): void {
    if (Fs.existsSync(this.file)) Fs.truncateSync(this.file, 0)
  }

  /** Newest-first records `accept` keeps, at most `limit` (none when the file is missing). */
  private scan(accept: (entry: QueryHistoryEntry) => boolean, limit: number): QueryHistoryEntry[] {
    if (!Fs.existsSync(this.file)) return []
    const descriptor = Fs.openSync(this.file, QueryHistoryStore.ReadFlag)
    try {
      return this.readTail(descriptor, accept, limit)
    } finally {
      Fs.closeSync(descriptor)
    }
  }

  /** Read chunks backwards until `limit` matching records are collected or the file start is reached. */
  private readTail(
    descriptor: number,
    accept: (entry: QueryHistoryEntry) => boolean,
    limit: number
  ): QueryHistoryEntry[] {
    const collected: QueryHistoryEntry[] = []
    let chunk: TailChunk = { lines: [], carry: Buffer.alloc(0), position: Fs.fstatSync(descriptor).size }
    while (collected.length < limit && (chunk.position > 0 || chunk.carry.length > 0)) {
      chunk = this.readChunk(descriptor, chunk)
      chunk.lines
        .reverse()
        .map(line => this.parseLine(line.toString(QueryHistoryStore.Encoding)))
        .filter(entry => entry != null && accept(entry))
        .forEach(entry => collected.push(entry))
      chunk = { ...chunk, lines: [] }
    }
    return collected.slice(0, limit)
  }

  /**
   * Read the chunk before `previous.position` and split it (plus the carried
   * bytes) into complete lines at the newline BYTE; the partial first line is
   * carried as raw bytes until the chunk holding its start is read.
   */
  private readChunk(descriptor: number, previous: TailChunk): TailChunk {
    const size = Math.min(this.config.tailChunkBytes, previous.position),
      position = previous.position - size,
      buffer = Buffer.alloc(size)
    Fs.readSync(descriptor, buffer, 0, size, position)
    const parts = QueryHistoryStore.splitLines(Buffer.concat([buffer, previous.carry]))
    if (position === 0) {
      return { lines: parts.filter(line => line.length > 0), carry: Buffer.alloc(0), position: 0 }
    }
    const [partial, ...complete] = parts
    return { lines: complete.filter(line => line.length > 0), carry: partial, position }
  }

  /** Decode one line; a malformed line is logged and skipped (null). */
  private parseLine(line: string): QueryHistoryEntry {
    return Either.try(() => QueryHistoryEntryCodec.deserialize(line)).match({
      Left: error => {
        log.warn(`skipping malformed history line in ${this.file}: ${error.message}`)
        return null
      },
      Right: identity
    })
  }
}

/** History constants. */
export namespace QueryHistoryStore {
  /** Default number of records listed. */
  export const DefaultListLimit = 100
  /** Default bytes read per backward tail chunk. */
  export const TailChunkBytes = 64 * 1024
  /** Record separator. */
  export const LineSeparator = "\n"
  /** The record separator's byte. */
  export const LineSeparatorByte = LineSeparator.charCodeAt(0)
  /** Text encoding of the log. */
  export const Encoding: BufferEncoding = "utf8"
  /** `open(2)` flag of an append (`O_APPEND`). */
  export const AppendFlag = "a"
  /** `open(2)` flag of a listing read. */
  export const ReadFlag = "r"

  /**
   * Split bytes at every {@link LineSeparatorByte} (no decoding — a split can
   * never land inside a UTF-8 sequence, whose bytes are all ≥ 0x80).
   *
   * @param bytes - The bytes.
   * @returns The pieces (one more than the separator count; pieces may be empty).
   */
  export function splitLines(bytes: Buffer): Buffer[] {
    const pieces: Buffer[] = []
    let start = 0,
      index = bytes.indexOf(LineSeparatorByte, start)
    while (index !== -1) {
      pieces.push(bytes.subarray(start, index))
      start = index + 1
      index = bytes.indexOf(LineSeparatorByte, start)
    }
    pieces.push(bytes.subarray(start))
    return pieces
  }
}
