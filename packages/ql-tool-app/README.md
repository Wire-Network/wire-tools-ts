# @wireio/ql-tool-app — WIRE QL desktop workbench

A desktop SQL workbench for WIRE nodes, in the style of MySQL Workbench's SQL editor:
browse contract tables, write queries with highlighting and completion, and page through
results — against any node running `sysio::query_engine_plugin`.

- **Platforms:** Linux (AppImage, deb), macOS (dmg, unsigned), Windows (nsis)
- **Stack:** Electron 44, React 19, MUI 9, Monaco, TanStack Table, Redux Toolkit, built on
  [`@wireio/ql-shared`](../ql-shared/README.md)
- **Private package** — built and packaged from this repository, never published to npm

---

## Overview

The workbench is the graphical counterpart of the [`wql` CLI and TUI](../ql-tool-cli/README.md).
All three use the same query client and the same profiles, saved queries and history
files, so a profile added with `wql profiles add` shows up in the app and vice versa.

Features:

- **Connections** — a connection manager for profiles (endpoint, timeouts, retries,
  owners) with a "Test connection" check.
- **Schema navigator** — owners → tables → key and value fields with their types; context
  actions to select rows, describe a table or copy its qualified name.
- **SQL editor** — tabs, semantic highlighting, completion of keywords, owners, tables and
  fields, hover types, live syntax errors, and engine errors marked at their position;
  format with Shift+Alt+F.
- **Results** — Grid, Form, JSON, Field Types, Stats, State and Messages tabs; server
  paging with a page-size picker or "All"; sort, filter, column chooser, find, a value
  inspector, and copy as TSV or JSON. Pin a result tab to keep it when you run again.
- **History and saved queries** — side panels to search, open or re-run.
- **Export** — table, JSON, JSONL, CSV, TSV, Markdown, HTML, XML or raw, for the current
  page or all rows, through the native save dialog.
- **Native look and feel** — native menus, context menus and dialogs, platform fonts, and
  light/dark appearance that follows the OS (or View → Appearance).

## Installation

Build from the `wire-tools-ts` repository root:

```bash
pnpm install
pnpm build
```

The Electron binary downloads on first launch (`setup:electron`, run by every launch and
packaging script). To produce an installable app for this host:

```bash
pnpm --filter @wireio/ql-tool-app package:linux   # AppImage + deb → dist/package/
pnpm --filter @wireio/ql-tool-app package:mac     # dmg, unsigned (on macOS)
pnpm --filter @wireio/ql-tool-app package:win     # nsis installer (on Windows)
pnpm --filter @wireio/ql-tool-app package:dir     # unpacked app only, no installer
```

Use these scripts as they are — don't pass extra flags after `--`: pnpm forwards the
literal `--` to electron-builder, which then ignores the flags after it.

## Getting started

1. **Have a node with the query engine.** For a local test cluster with one API node, see
   the [`wql` Getting started](../ql-tool-cli/README.md#getting-started); the endpoint is
   `http://127.0.0.1:<port>` with the port from
   `jq -r '.bind.nodeop.ports.api[0].http' <cluster>/cluster-config.json`.
2. **Start the app:**

   ```bash
   pnpm --filter @wireio/ql-tool-app start
   ```

3. **Connect.** Open the connection manager (CmdOrCtrl+,), add a profile with that
   endpoint, press **Test connection**, and select it.
4. **Query.** Expand an owner in the navigator, right-click a table → **Select Rows**, or
   type a query and press CmdOrCtrl+Enter:

   ```sql
   SELECT * FROM "sysio.opreg".operators
   ```

## Usage

### Keyboard shortcuts

| Shortcut | Action |
|---|---|
| CmdOrCtrl+Enter | run the query |
| CmdOrCtrl+Shift+Enter | run the selection |
| CmdOrCtrl+. | stop waiting for the running query |
| CmdOrCtrl+T / CmdOrCtrl+W | new / close editor tab |
| CmdOrCtrl+O / CmdOrCtrl+S | open / save a `.sql` file |
| CmdOrCtrl+E | export the result |
| Shift+Alt+F | format the SQL |
| CmdOrCtrl+F | find in the editor or in the results (by focus) |
| F5 | reload the schema catalog |
| CmdOrCtrl+Shift+S | save the query as a saved query |
| CmdOrCtrl+Shift+H / CmdOrCtrl+Shift+L | show the history / saved-queries panel |
| CmdOrCtrl+, | connections |

### Paging

Every page is a separate server request, read at its own block; the pager bar shows
`page N/M · total · block` and flags when a page came from a different block than the
previous one. **All** fetches every row in one request, capped by the node's
`query-max-result-rows`. The toolbar's **Offset** and **Limit** fields set an explicit
window. Sorting, filtering and find act on the rows of the loaded page.

### Stop and Retry

**Stop** stops waiting for a response; the node keeps working on the query until its own
deadline. **Retry** is enabled when the server marked a failure retryable.

### History

Every query request you start — a run, a Retry, a page change, an "All rows" export —
adds one entry to the shared `history.jsonl`. Catalog lookups (loading an owner,
describing a table, Test connection) are not recorded.

## Configuration

| What | Where |
|---|---|
| Profiles, saved queries, history | the files shared with `wql` — see [Files](../ql-tool-cli/README.md#files) |
| Window size and appearance | the app's user-data directory |
| Logs | `<userData>/logs/main.log`, `query-host.log`, `renderer.log` |
| Log level | `LOG_LEVEL` environment variable (all processes) |

## Development

```bash
pnpm --filter @wireio/ql-tool-app dev        # renderer dev server with hot reload; launches Electron
pnpm --filter @wireio/ql-tool-app start      # production bundles, then launch
pnpm --filter @wireio/ql-tool-app test       # jest (Electron mocked; renderer under jsdom)
pnpm --filter @wireio/ql-tool-app test:unit  # build all four bundles + smoke tests (tests/node/)
pnpm --filter @wireio/ql-tool-app test:e2e   # Playwright against a stub engine (tests/e2e/)
```

### Architecture

| Process | Entry | Role |
|---|---|---|
| main | `src/main/main.ts` | windows, menus, dialogs, appearance, profile/history/saved-query files, file logging |
| query host | `src/query-host/main.ts` | one `utilityProcess` that runs every query and catalog load, so the UI never blocks; each window talks to it over its own message port |
| preload | `src/preload/preload.ts` | exposes the typed `window.wireQL` bridge to the page |
| renderer | `src/renderer/index.tsx` | the React UI; no Node access |

If the query host crashes it restarts with a growing delay; after more than five crashes
in a minute it stays down until you press **Restart** in the status bar.

The windows use Electron's standard security settings: context isolation, no Node in the
page, the renderer sandbox, a Content-Security-Policy
(`src/common/QLContentSecurityPolicy.ts`), no `window.open`, no navigation away from the
app, and IPC accepted only from the app's own page. There are no credentials anywhere.

### Project layout

| Path | Contents |
|---|---|
| `etc/webpack/` | the four webpack bundles (main, preload, query host, renderer) |
| `etc/electron-builder/` | packaging targets |
| `etc/app-identity/app-identity.cjs` | app id, executable and package names (read by webpack and electron-builder) |
| `etc/playwright/` | e2e configuration |
| `scripts/electron/` | the launcher used by `start`, `dev` and the e2e tests |
| `resources/` | HTML shell and brand assets |

### End-to-end tests

- Electron runs on a virtual X display (Xvfb when installed, otherwise a nested Xephyr in
  your session); the display server is stopped when the test runner exits, even on
  Ctrl+C.
- `tests/e2e/packaged.spec.ts` launches the unpacked package and fails, naming the build
  command, when it is missing: `pnpm --filter @wireio/ql-tool-app package:dir`.
- Stub engine ports come from the bind registry.

### Icons

`resources/assets/brand/icon-*.png` are generated from `wire-mark.svg` and the brand color
by `./scripts/generate-ql-app-icons.mjs` (repository root); `scripts/check.mjs` verifies
them.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `FATAL: The SUID sandbox helper binary was found, but is not configured correctly` | Chromium cannot use its OS sandbox on this host (Ubuntu 24.04 restricts user namespaces, and `chrome-sandbox` in `node_modules` is not setuid root). `start`, `dev` and the e2e tests detect this and launch with `--no-sandbox`; launching `electron` by hand needs the same flag. To keep the OS sandbox instead, make the helper setuid root: `sudo chown root:root <electron>/dist/chrome-sandbox && sudo chmod 4755 <electron>/dist/chrome-sandbox` (redo after every reinstall). |
| Run reports "query host failed" | the query host crashed repeatedly; press **Restart** in the status bar and check `logs/query-host.log` |
| Connection test fails with a schema-version error | the node's query engine predates response schema `1.1`; use a newer nodeop |
| No owners in the navigator | the profile's owner list is empty or wrong; edit it in the connection manager |

## Related packages

- [`@wireio/ql-shared`](../ql-shared/README.md) — the query client, formats and storage
- [`@wireio/ql-tool-cli`](../ql-tool-cli/README.md) — `wql` command line and terminal workbench
