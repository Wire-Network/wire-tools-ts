import type { IncomingMessage, ServerResponse } from "node:http"

import {
  LogicalType,
  QueryEngineRPC,
  QueryErrorCode,
  QueryErrorKind,
  ValueEncoding,
  type QueryColumn,
  type QueryRequestParams,
  type QueryResult,
  type QueryRow
} from "@wireio/ql-shared"

import { TestHttpServer } from "./TestHttpServer.js"

/** One stub table. */
export interface StubTable {
  /** Column metadata. */
  columns: QueryColumn[]
  /** All rows (paged by the request window). */
  rows: QueryRow[]
  /** Answer delay (ms). */
  delayMs: number
}

/** A canned engine error. */
export interface StubError {
  /** Kind. */
  kind: QueryErrorKind
  /** Message. */
  message: string
  /** Server retryable flag. */
  retryable: boolean
  /** 1-based line (null = not positional). */
  line: number
  /** 1-based column. */
  column: number
}

/** One recorded `query.execute` request. */
export interface StubRequest {
  /** The params as received. */
  params: QueryRequestParams
  /** Arrival time (ms). */
  at: number
}

/**
 * A `node:http` stand-in for a node's query engine (`POST /v1/query/execute`,
 * schema 1.1 with server paging) and chain API (`POST /v1/chain/get_abi`), with
 * the `sample` owner's tables: `positions` (3 rows), `big` (10 000 × 12),
 * `slow` (answers after 3 s), `busy` (retryable QUERY_BUSY) — and a QUERY_SYNTAX
 * error for any JOIN. It runs on a {@link TestHttpServer} (registry-issued port).
 */
export class StubQueryEngine {
  /** Every execute request received. */
  readonly requests: StubRequest[] = []
  private blockNumber = StubQueryEngine.FirstBlock
  /** Answer-delay timers still pending (cleared by {@link close} so none outlives the stub). */
  private readonly delays = new Set<ReturnType<typeof setTimeout>>()

  /** The listening server (set by {@link start}). */
  private http: TestHttpServer = null

  /** Base URL (`http://127.0.0.1:<port>`). */
  get url(): string {
    return this.http.url
  }

  /** The registry-issued port. */
  get port(): number {
    return this.http.port
  }

  /**
   * Start on a registry-issued port.
   *
   * @returns The running stub.
   */
  static async start(): Promise<StubQueryEngine> {
    const stub = new StubQueryEngine()
    stub.http = await TestHttpServer.start((request, response) => void stub.handle(request, response))
    return stub
  }

  /** Stop listening (pending answer delays cleared, keep-alive sockets closed). */
  async close(): Promise<void> {
    this.delays.forEach(timer => clearTimeout(timer))
    this.delays.clear()
    await this.http.close()
  }

  /**
   * Route one HTTP request.
   *
   * @param request - The request.
   * @param response - The response.
   */
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
    const reply = (payload: object) => {
      if (response.destroyed) return
      response.writeHead(TestHttpServer.OkStatus, { "content-type": "application/json" })
      response.end(JSON.stringify(payload))
    }
    if (request.url === StubQueryEngine.AbiPath) {
      reply(StubQueryEngine.abiResponse(body.account_name))
      return
    }
    const params = body.params as QueryRequestParams
    this.requests.push({ params, at: Date.now() })
    const failure = StubQueryEngine.errorFor(params.query)
    if (failure != null) {
      reply(StubQueryEngine.errorEnvelope(body.id, failure))
      return
    }
    const table = StubQueryEngine.tableFor(params.query)
    if (table.delayMs > 0) await this.delay(table.delayMs)
    this.blockNumber += 1
    reply({ jsonrpc: "2.0", id: body.id, result: StubQueryEngine.resultOf(table, params, this.blockNumber) })
  }

  /**
   * Wait `ms` on a tracked timer ({@link close} clears it; the request is then dropped).
   *
   * @param ms - Delay.
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.delays.delete(timer)
        resolve()
      }, ms)
      this.delays.add(timer)
    })
  }
}

/** Stub data + envelope builders. */
export namespace StubQueryEngine {
  /** Loopback host (the server's). */
  export const Host = TestHttpServer.Host
  /** Chain API path. */
  export const AbiPath = "/v1/chain/get_abi"
  /** The stub owner. */
  export const Owner = "sample"
  /** First block number answered. */
  export const FirstBlock = 1_000
  /** Rows of `sample.big`. */
  export const BigRowCount = 10_000
  /** Columns of `sample.big`. */
  export const BigColumnCount = 12
  /** Answer delay of `sample.slow` (ms). */
  export const SlowDelayMs = 3_000
  /** 64-hex chain id. */
  export const ChainId = "c".repeat(64)

  /**
   * A column of a logical type.
   *
   * @param name - Column name.
   * @param logicalType - Logical type.
   * @param encoding - Wire encoding.
   * @returns The column.
   */
  export function column(name: string, logicalType: LogicalType, encoding: ValueEncoding): QueryColumn {
    return { name, logical_type: logicalType, abi_type: null, nullable: true, encoding }
  }

  /** `sample.positions`. */
  export const Positions: StubTable = {
    columns: [
      column("name", LogicalType.text, ValueEncoding.text),
      column("amount", LogicalType.integer, ValueEncoding.decimal_string),
      column("balance", LogicalType.asset, ValueEncoding.asset_object)
    ],
    rows: [
      { name: "alice", amount: "10", balance: { amount: "1.5", symbol: "SYS", precision: "4" } },
      { name: "bob", amount: "-3", balance: { amount: "20", symbol: "SYS", precision: "4" } },
      { name: "carol", amount: "250", balance: { amount: "0.25", symbol: "SYS", precision: "4" } }
    ],
    delayMs: 0
  }

  /** `sample.big` (10 000 × 12). */
  export const Big: StubTable = {
    columns: Array.from({ length: BigColumnCount }, (_value, index) =>
      column(`c${index}`, LogicalType.integer, ValueEncoding.decimal_string)
    ),
    rows: Array.from({ length: BigRowCount }, (_row, rowIndex) =>
      Object.fromEntries(
        Array.from({ length: BigColumnCount }, (_value, index) => [`c${index}`, String(rowIndex * BigColumnCount + index)])
      )
    ),
    delayMs: 0
  }

  /** `sample.slow`. */
  export const Slow: StubTable = { ...Positions, delayMs: SlowDelayMs }

  /** Tables by name. */
  export const Tables: Readonly<Record<string, StubTable>> = { positions: Positions, big: Big, slow: Slow, busy: Positions }

  /**
   * The table a query reads (`FROM [owner.]table`; positions by default).
   *
   * @param query - SQL.
   * @returns The table.
   */
  export function tableFor(query: string): StubTable {
    const name = /from\s+(?:"?[\w.]+"?\.)?(\w+)/i.exec(query)?.[1]?.toLowerCase()
    return Tables[name] ?? Positions
  }

  /**
   * The canned error of a query, if any (JOIN → QUERY_SYNTAX; `busy` → retryable QUERY_BUSY).
   *
   * @param query - SQL.
   * @returns The error, or undefined.
   */
  export function errorFor(query: string): StubError {
    if (/\bjoin\b/i.test(query)) {
      const column = query.toLowerCase().indexOf("join") + 1
      return { kind: QueryErrorKind.QUERY_SYNTAX, message: "JOIN is not supported", retryable: false, line: 1, column }
    }
    if (/\bbusy\b/i.test(query)) {
      return { kind: QueryErrorKind.QUERY_BUSY, message: "engine busy", retryable: true, line: null, column: null }
    }
    return undefined
  }

  /**
   * A schema 1.1 result for the request window.
   *
   * @param table - The table.
   * @param params - The request params.
   * @param blockNumber - The answering block.
   * @returns The result.
   */
  export function resultOf(table: StubTable, params: QueryRequestParams, blockNumber: number): QueryResult {
    const { offset = 0, limit } = params,
      start = Math.min(offset, table.rows.length),
      rows = table.rows.slice(start, limit == null ? undefined : start + limit),
      blockId = blockNumber.toString(16).padStart(64, "0")
    return {
      schema_version: QueryEngineRPC.SchemaVersion,
      complete: true,
      source: { owners: [Owner], table: "positions" },
      state: {
        chain_id: ChainId,
        block_id: blockId,
        block_num: String(blockNumber),
        block_time: "2026-10-07T12:00:00.000",
        read_mode: "head",
        last_irreversible_block_num: String(blockNumber - 2),
        abis: [{ owner: Owner, hash: "a".repeat(64) }],
        captured_at: "2026-10-07T12:00:00.050000Z",
        synced: true
      },
      columns: table.columns,
      rows,
      stats: {
        scanned_rows: String(table.rows.length),
        matched_rows: String(table.rows.length),
        groups: "0",
        returned_rows: String(rows.length),
        raw_bytes: "100",
        elapsed_us: "1200"
      },
      page: {
        offset: String(start),
        limit: limit == null ? null : String(limit),
        returned_rows: String(rows.length),
        total_rows: String(table.rows.length),
        has_more: start + rows.length < table.rows.length
      }
    } as QueryResult
  }

  /**
   * A JSON-RPC error envelope.
   *
   * @param id - Request id.
   * @param failure - The canned error.
   * @returns The envelope.
   */
  export function errorEnvelope(id: unknown, failure: StubError): object {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: QueryErrorCode[failure.kind],
        message: failure.message,
        data: { kind: failure.kind, retryable: failure.retryable, line: failure.line, column: failure.column, limit: null }
      }
    }
  }

  /**
   * `get_abi` of the stub owner (tables with a `uint64 id` key).
   *
   * @param account - Requested account.
   * @returns The response.
   */
  export function abiResponse(account: string): object {
    return {
      account_name: account,
      abi: {
        version: "sysio::abi/1.2",
        types: [],
        structs: [
          {
            name: "position",
            base: "",
            fields: [
              { name: "name", type: "string" },
              { name: "amount", type: "int64" },
              { name: "balance", type: "asset" }
            ]
          }
        ],
        actions: [],
        tables: Object.keys(Tables).map(name => ({
          name,
          index_type: "i64",
          key_names: ["id"],
          key_types: ["uint64"],
          type: "position"
        })),
        ricardian_clauses: [],
        error_messages: [],
        abi_extensions: [],
        variants: [],
        action_results: []
      }
    }
  }
}
