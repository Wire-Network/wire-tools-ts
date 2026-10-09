# @wireio/ql-tool-cli

**`wql`** — run SQL `SELECT`s against a WIRE node's contract tables from the command line —
and **`wire-ql-tui`**, an interactive terminal workbench for the same thing.

- **Binaries:** `wql` (alias `wire-ql`), `wire-ql-tui` (same as `wql tui`)
- **Talks to:** a node running `sysio::query_engine_plugin` (`POST /v1/query/execute`,
  response schema `1.1`)
- **Stack:** Node ≥ 24.9, yargs, Ink 8 + React 19 + Redux Toolkit, built on
  [`@wireio/ql-shared`](../ql-shared/README.md)

---

## Overview

A WIRE API node with the query engine answers read-only SQL over contract tables, at one
block snapshot per request:

```sql
SELECT account, status FROM "sysio.opreg".operators WHERE status = 'OPERATOR_STATUS_ACTIVE'
```

`wql` sends a query, prints the result in one of nine formats, and exits with a code that
says what happened — so it works interactively and in scripts. `wql tui` opens a
full-screen workbench: a schema browser, an SQL editor with highlighting and live syntax
errors, and result tabs.

What you get:

- **Server paging** — every page is one request; `--page`, `--page-size`, `--offset`,
  `--limit`, or `--all` for everything in one request.
- **Nine output formats** — `table`, `json`, `jsonl`, `csv`, `tsv`, `markdown`, `html`,
  `xml`, `raw`; write to a file with `--output-file`.
- **Connection profiles, saved queries and history** — shared with the TUI and the
  [desktop app](../ql-tool-app/README.md).
- **Schema browsing** — owners, tables, fields and value types.
- **Precise values** — integers, decimals and assets are printed exactly as the chain
  stores them.

## Installation

From the `wire-tools-ts` repository root:

```bash
pnpm install
pnpm --filter @wireio/ql-shared --filter @wireio/ql-tool-cli build
```

Run the bins directly, or link them onto your `PATH` (`wql`, `wire-ql`, `wire-ql-tui`):

```bash
node packages/ql-tool-cli/bin/wql --help
cd packages/ql-tool-cli && pnpm link --global
```

The examples below write `wql`; without the global link use `node packages/ql-tool-cli/bin/wql`.

You also need a node that serves the query engine (see Getting started).

## Getting started

### 1. Start a node with the query engine

Any nodeop that loads `query_engine_plugin` works. For a local test cluster with one API
node:

```bash
node packages/cluster-tool/bin/wire-cluster-tool create --cluster-path /tmp/wire-ql \
  --build-path <wire-sysio>/build/debug \
  --ethereum-path <wire-ethereum> --solana-path <wire-solana> \
  --api-count 1
node packages/cluster-tool/bin/wire-cluster-tool run -d /tmp/wire-ql   # keeps running

API_PORT=$(jq -r '.bind.nodeop.ports.api[0].http' /tmp/wire-ql/cluster-config.json)
```

### 2. Save a connection profile

```bash
wql profiles add local "http://127.0.0.1:${API_PORT}" --default
```

### 3. Query

```bash
wql 'SELECT * FROM "sysio.opreg".operators'
wql schema tables sysio.opreg
wql tui
```

Owner names that contain a dot must be quoted (`"sysio.opreg".operators`).

## Usage

### Command line

```text
wql [query]                     run a query (the default command)
wql tui [query]                 open the terminal workbench (== wire-ql-tui)
wql schema owners               list owners
wql schema tables <owner>       list an owner's tables
wql schema fields <owner> <table>
wql schema describe <owner> <table>
wql profiles list | add <name> <endpoint> [--default] | remove <name> | default <name>
wql history list [--search text] [--count n] | clear | rerun <id>
wql saved list | save <name> [query] | run <name> | remove <name>
```

The query comes from exactly one place: the positional argument, `--query-file`/`-F`, or
stdin (`-` or a pipe).

### Examples

```bash
# One page (100 rows by default) as a table
wql 'SELECT * FROM "sysio.opreg".operators'

# Page 2 of 50 rows
wql --page 2 --page-size 50 'SELECT * FROM "sysio.opreg".operators'

# Everything, written as CSV (format from the file extension)
wql --all --output-file operators.csv 'SELECT * FROM "sysio.opreg".operators'

# JSON from stdin
echo 'SELECT * FROM sample.positions' | wql -f json

# A query file, with server statistics and the block it was read at
wql -F query.sql --show-stats --show-state

# Without a profile
wql --url http://127.0.0.1:8888 'SELECT …'

# Exit codes in scripts
wql 'SELECT …' > out.txt || echo "wql failed with $?"
```

### Paging

| Flags | Request sent |
|---|---|
| (none) | first page: `limit 100, offset 0` |
| `--page N --page-size S` | `offset (N-1)·S, limit S` |
| `--offset O --limit L` | exactly that window (the engine also applies any SQL `LIMIT`) |
| `--all` | one request without `limit`; still capped by the node's `query-max-result-rows` |

`--all` cannot be combined with other paging flags, and `--offset`/`--limit` cannot be
combined with `--page`/`--page-size`. Each page is read at its own block, so pages of a
moving chain can come from different blocks (`--show-state` shows which). Table and
Markdown output end with `page N/M · rows a–b of total · block <num>`, and when more rows
exist the next `--page` is suggested on stderr.

`--columns`, `--sort col[:desc]` and `--filter col=text` act on the rows of the page you
fetched; use SQL `ORDER BY` for server-side order. Repeat a flag for several values
(`--sort a --sort b:desc`).

### Output

| Format | Notes |
|---|---|
| `table` | default; colored when stdout is a terminal |
| `json`, `jsonl` | one document / one row per line |
| `csv`, `tsv`, `markdown`, `html`, `xml` | `--no-header` omits the header row |
| `raw` | the engine's result exactly as received (no `--sort`/`--filter`/`--columns`) |

`--output-file`/`-o` writes to a file and picks the format from its extension unless
`--format` is given. Results go to stdout only; errors and hints go to stderr, so output
can be piped.

### Keybindings (TUI)

| Key | Action | Key (results grid) | Action |
|---|---|---|---|
| Ctrl+R | run | ↑ ↓ ← → | move the cursor |
| Alt+R | retry a retryable failure | PgUp / PgDn | previous / next page |
| Esc | cancel the run / close a dialog | Home / End | first / last page |
| Tab / Shift+Tab | next / previous panel | z | cycle the page size (then All) |
| Alt+J / Alt+V | JSON view / record view | s / f | sort / filter this column |
| Alt+E | export | c | show / hide columns |
| Alt+F | format the SQL | / | find in results |
| Alt+H / Alt+O / Alt+P | history / saved queries / profiles | i | inspect the cell |
| Alt+W | save the query | y | copy the row |
| Alt+L | set an offset,limit window | | |
| Alt+? | help | Ctrl+Z (editor) | undo |
| Ctrl+C | quit | | |

In the schema tree: ↑ ↓ to move, Enter to expand or insert a name, → for fields, `d` to
describe a table. The Profiles screen adds (`a`), edits (`e`), selects (Enter), sets the
default (`d`) and removes (`x`) profiles.

## Configuration

### Connection

| Flag | Environment | Default | Meaning |
|---|---|---|---|
| `--profile`, `-p` | `WIRE_QL_PROFILE` | the default profile | saved profile to use |
| `--url`, `-u` | `WIRE_QL_URL` | — | node endpoint, used when no profile is given |
| `--timeout-ms` | — | the profile's, else the node's | server deadline; can only lower the node's `query-timeout-ms` |
| `--transport-timeout-ms` | — | 10000 | how long the client waits for a response |
| `--retries` | — | 2 | automatic retries of busy / schema-changed / state-unavailable failures |
| `--owners` | — | every system contract | owners the schema browser lists |

The connection is resolved from flags, then the named profile, then the default profile;
with none of them `wql` exits 2 and suggests `wql profiles add`. `wql --help` prints the
effective defaults.

### Files

Profiles, saved queries and history are shared with the TUI and the desktop app:

| File | Linux | macOS | Windows |
|---|---|---|---|
| `profiles.json`, `saved-queries.json` | `$XDG_CONFIG_HOME/wire-ql` (else `~/.config/wire-ql`) | `~/Library/Application Support/wire-ql` | `%APPDATA%\wire-ql` |
| `history.jsonl`, `logs/tui.log` | `$XDG_STATE_HOME/wire-ql` (else `~/.local/state/wire-ql`) | `~/Library/Logs/wire-ql` | `%LOCALAPPDATA%\wire-ql` |

### Logging

`--log-level` (default `error`) sets the diagnostics written to stderr. The TUI writes
diagnostics only to `logs/tui.log`, at `--log-level`, else `LOG_LEVEL`.

### Exit codes

| Code | Meaning | Code | Meaning |
|---|---|---|---|
| 0 | success | 15 | `SCHEMA_CHANGED` |
| 1 | failure (file I/O, unknown saved query, …) | 16 | `ROW_DECODE_ERROR` |
| 2 | usage (bad flags, no connection, no query) | 17 | `VALUE_ERROR` |
| 3 | transport (unreachable, timeout, bad response, schema version) | 18 | `STATE_UNAVAILABLE` |
| 10 | `QUERY_SYNTAX` (stderr marks the position) | 19 | `QUERY_CANCELLED` |
| 11 | `QUERY_SEMANTICS` | 20 | `PARSE_ERROR` / `INVALID_REQUEST` / `METHOD_NOT_FOUND` / `INVALID_PARAMS` |
| 12 | `QUERY_LIMIT` | 21 | `INTERNAL_ERROR` |
| 13 | `QUERY_TIMEOUT` | 130 | interrupted (Ctrl+C) |
| 14 | `QUERY_BUSY` | | |

Ctrl+C stops waiting for the response; the node keeps working on the query until its own
deadline.

## Development

```bash
pnpm --filter @wireio/ql-tool-cli build       # type-check + esbuild bundle (dist/bundle/wql.mjs)
pnpm --filter @wireio/ql-tool-cli test        # jest (tests/ mirrors src/)
pnpm --filter @wireio/ql-tool-cli test:unit   # bundle, then smoke-test the bins (tests/node/)
```

- The package is ESM and ships as one esbuild bundle, `dist/bundle/wql.mjs`; the TUI is a
  separate chunk loaded only by `wql tui`. The bins load the bundle, and importing the
  package (`import { main } from "@wireio/ql-tool-cli"`) has no side effects until
  `main(argv)` is called.
- Build helpers live in `scripts/esbuild/`: `filenamePlugin.cjs` keeps each module's own
  log category inside the bundle, and the jest transformers compile the ESM sources for
  jest.
- Tests mock Ink and drive the TUI's key handlers directly; stub engine servers take their
  ports from the bind registry.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `exit 2` with "no connection" | add a profile (`wql profiles add …`) or pass `--url` |
| `exit 3`, connection refused | the node is not running, or the URL is not its `http-server-address` |
| `exit 3` naming two schema versions, or `exit 20` with an upgrade hint | the node's query engine predates response schema `1.1`; use a newer nodeop |
| `exit 10` at the `.` of `FROM sysio.opreg.operators` | quote an owner that contains a dot: `FROM "sysio.opreg".operators` |
| `exit 12` (`QUERY_LIMIT`) | the page is larger than `query-max-result-rows`; lower `--page-size` or drop `--all` |
| The TUI shows nothing useful when it fails | read `logs/tui.log` under the state directory (see Files) |

## Related packages

- [`@wireio/ql-shared`](../ql-shared/README.md) — the client, formats and storage this CLI uses
- [`@wireio/ql-tool-app`](../ql-tool-app/README.md) — the desktop workbench
- [`@wireio/cluster-tool`](../cluster-tool/README.md) — `wire-cluster-tool create --api-count`
  for a local node with the query engine
