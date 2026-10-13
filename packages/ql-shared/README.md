# @wireio/ql-shared

The shared library behind **WIRE QL**: a typed client for a WIRE node's query engine
(`sysio::query_engine_plugin`), plus the result formatting, SQL grammar tooling, schema
catalog and local storage that the `wql` CLI / TUI and the desktop app all use.

- **Used by:** [`@wireio/ql-tool-cli`](../ql-tool-cli/README.md) (`wql`, `wire-ql-tui`) and
  [`@wireio/ql-tool-app`](../ql-tool-app/README.md) (desktop workbench)
- **Module format:** CommonJS; the root entry is browser-safe, Node-only storage lives under
  `@wireio/ql-shared/node`
- **Talks to:** `POST /v1/query/execute` (JSON-RPC 2.0, method `query.execute`, response
  schema `1.1`)

---

## Overview

A node that loads `query_engine_plugin` answers one read-only `SELECT` per request against
its contract tables, at a single block snapshot. This package wraps that endpoint so a
client never deals with raw JSON-RPC:

- **Query client.** `QueryEngineClient` sends a query, validates the response against the
  engine's schema, maps engine errors to typed failures, retries server-retryable failures,
  and pages on the server (`limit` / `offset` / `timeout_ms`).
- **Results.** `ResultView` sorts, filters and projects the rows of a page, `QueryPager`
  turns "page N of size S" into a request window, and `ResultRenderer` prints a result as
  `table`, `json`, `jsonl`, `csv`, `tsv`, `markdown`, `html`, `xml` or `raw`.
- **Values.** `CellFormatter` and `ValueInspector` display every engine value type
  (decimal strings, assets, times, enums, JSON, IEEE floats) without losing precision.
- **SQL tooling.** A lexer/parser generated from the engine's own `WireQuery.g4` drives
  syntax highlighting, grammar diagnostics, formatting and completion.
- **Schema catalog.** `SchemaCatalog` lists owners, tables and fields from `get_abi`, and
  value types from a `LIMIT 0` describe.
- **Local storage.** Connection profiles, saved queries and query history, stored in files
  every WIRE QL tool shares.

Because every tool goes through this one package, the CLI, the TUI and the desktop app
show the same values, page the same way and report the same errors.

## Installation

Inside `wire-tools-ts` the package is a workspace dependency:

```json
{ "dependencies": { "@wireio/ql-shared": "workspace:*" } }
```

```bash
pnpm install
pnpm --filter @wireio/ql-shared build
```

The node must run `query_engine_plugin` with response schema `1.1` (HTTP paging). An older
node answers paged requests with `INVALID_PARAMS`; the client reports that as "this node's
query engine predates HTTP paging" rather than falling back.

## Getting started

```ts
import {
  ConnectionProfileSchema,
  QueryEngineClient,
  QueryExecutionStatus,
  QueryPager,
  ResultRenderer,
  ResultView,
  OutputFormat
} from "@wireio/ql-shared"

const profile = ConnectionProfileSchema.parse({ name: "local", endpoint: "http://127.0.0.1:8888" }),
  client = new QueryEngineClient(profile),
  pager = new QueryPager({ pageSize: 50 }),
  execution = await client.execute('SELECT * FROM "sysio.opreg".operators', pager.window)

if (execution.status === QueryExecutionStatus.success) {
  const view = ResultView.create(execution.result)
  process.stdout.write(
    ResultRenderer.render(OutputFormat.table, { execution, view, range: { start: 0, end: view.rowCount } })
  )
} else {
  // execution.failure: kind (engine / transport / cancelled), message, engine code + data
}
```

`execute` never throws for an engine or network failure; it returns a `QueryExecution`
whose `status` says which.

## Usage

### Paging

Every page is its own server request. Page N of size S sends `offset = (N-1)·S` and
`limit = S`; the response's `result.page` (`offset`, `limit`, `returned_rows`,
`total_rows`, `has_more`) gives the page count. Each page is read at its own block, so
pages of a moving chain can come from different blocks. "All rows" is one request without
`limit`, still capped by the node's `query-max-result-rows`.

### Timeouts and retries

A profile carries two timeouts: `queryTimeoutMs` is sent as `timeout_ms` and can only
lower the node's `query-timeout-ms`; `transportTimeoutMs` is the client's own fetch
ceiling. The client automatically retries `QUERY_BUSY`, `SCHEMA_CHANGED` and
`STATE_UNAVAILABLE` when the server marks them retryable (`retries` times, with backoff);
any other retryable failure is left to the user.

### Local storage (`@wireio/ql-shared/node`)

| File | Location (Linux · macOS · Windows) |
|---|---|
| `profiles.json`, `saved-queries.json` | `$XDG_CONFIG_HOME/wire-ql` (else `~/.config/wire-ql`) · `~/Library/Application Support/wire-ql` · `%APPDATA%\wire-ql` |
| `history.jsonl`, `logs/` | `$XDG_STATE_HOME/wire-ql` (else `~/.local/state/wire-ql`) · `~/Library/Logs/wire-ql` · `%LOCALAPPDATA%\wire-ql` |

`ConnectionProfileStore`, `SavedQueryStore` and `QueryHistoryStore` read and write these
files; profile and saved-query writes are atomic and the last writer wins. A profile holds
an endpoint, timeouts, retries and owners — nothing secret.

### Modules

| Module | Contents |
|---|---|
| `protocol/` | zod schemas mirroring the engine's request / response / error shapes, and the engine enums (`LogicalType`, `ValueEncoding`, `QueryErrorKind`, `QueryErrorCode`) |
| `errors/` | `QueryEngineError`, `QueryTransportError` |
| `client/` | `QueryEngineClient`, `QueryRetryPolicy`, `QueryExecution` |
| `values/` | `CellFormatter`, `ValueInspector`, `DisplayWidth` |
| `results/` | `ResultView`, `QueryPager`, `PagedQuery`, `ResultSummary`, `ResultSearch`, `ResultSelection`, `DelimitedText` |
| `rendering/` | `ResultRenderer`, `OutputFormat` |
| `grammar/` | `SyntaxHighlighter`, `QueryDiagnostics`, `QueryFormatter`, `CompletionProvider`, `QueryText`; the generated parser in `generated/` |
| `catalog/` | `SchemaCatalog`, `CatalogSnapshot` |
| `profiles/` | `ConnectionProfile`, `ConnectionProfileForm`, `SavedQuery`, `QueryHistoryEntry` |
| `node/` | `QLPaths`, the three stores, `FileLogging` |
| `brand/` | `QLBrand` (product name, CLI name, brand color) |

## Development

```bash
pnpm --filter @wireio/ql-shared build   # tsc -b → lib/cjs
pnpm --filter @wireio/ql-shared test    # jest; tests/ mirrors src/
pnpm --filter @wireio/ql-shared bench   # timings for a 10k × 12 result (after a build; not part of the gate)
```

The grammar and the engine schema copies come from the sibling `wire-sysio` checkout:

```bash
./scripts/generate-wql-types.mjs           # from wire-tools-ts: regenerate
./scripts/generate-wql-types.mjs --check   # verify the committed copies (run by scripts/check.mjs)
```

Source hashes are recorded in `src/grammar/GRAMMAR_SOURCE.json` and
`src/protocol/SCHEMA_SOURCE.json`; `--check` fails on drift. The root entry must stay free
of Node builtins — `tests/barrel/BrowserSafeRoot.test.ts` bundles it for the browser.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Transport failure naming two schema versions | The node's query engine is older or newer than response schema `1.1`; use a matching nodeop build |
| `INVALID_PARAMS` with an upgrade hint | The node predates HTTP paging (`limit` / `offset` / `timeout_ms`) |
| `QUERY_LIMIT` with `data.limit = query-max-result-rows` | The page (or an "All rows" request) is larger than the node allows; use a smaller page |

## Related packages

- [`@wireio/ql-tool-cli`](../ql-tool-cli/README.md) — `wql` command line and terminal workbench
- [`@wireio/ql-tool-app`](../ql-tool-app/README.md) — desktop workbench
- [`@wireio/cluster-tool-shared`](../cluster-tool-shared) — the shared JSON-RPC transport and `SchemaCodec`
