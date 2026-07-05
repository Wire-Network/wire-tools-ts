# @wireio/debugging-client-tool-tui

A React + Ink terminal UI for observing a running WIRE test cluster. Tails OPP envelope writes, monitors every cluster-spawned process (including Anvil and `solana-test-validator`), and lets you scroll through per-node logs — all from a single terminal pane.

- **Binary:** `wire-debugging-client-tool-tui`
- **Stack:** Node ≥22, React 19, Ink 7, Redux Toolkit, `ts-pattern`, `@3fv/prelude-ts`
- **Targets:** clusters built with the sibling `@wireio/cluster-tool` package (`wire-cluster-tool` CLI).

---

## Overview

When you run an end-to-end test cluster with `wire-cluster-tool`, the harness spawns a collection of long-lived processes (WIRE `nodeop` nodes, a `kiod` wallet daemon, optionally `anvil` and `solana-test-validator`) and an embedded OPP debugging HTTP server. Each spawned process writes a pid file and an on-disk log under `<cluster-path>/data/`, and the debugging server persists OPP envelopes under `<cluster-path>/data/opp-debugging/`.

This TUI reads from that on-disk layout. It is **non-destructive** — it never starts, stops, or signals cluster processes. It only watches pid files, tails logs, and dispatches decoded envelopes into a Redux store that drives a keyboard-navigable panel layout.

### Design highlights

- **File-only logging.** Everything the TUI emits goes to `<cluster-path>/data/tui/logs/tui.log` via a rolling `FileAppender` from `@wireio/shared/node`. Nothing leaks to stdout — stray console writes corrupt Ink's frame buffer, so there is no console appender, intentionally.
- **Service framework with dependency-ordered boot.** Features register `Service` classes (`id`, `dependsOn`, `init`/`start`/`stop`) into a `ServiceManager` that topologically orders startup and reverses the order on teardown. Services are obtained from React components via `useService<T>(id)`.
- **Plugin-style `FeatureProvider`s.** Each feature owns its panels, status-bar widgets, and services in one self-contained directory. Features are filtered at startup via `--features`.
- **Pid-file-driven process discovery.** Instead of constructing labels from heuristics, the process monitor scans `<cluster-path>/data/**/*.pid` and uses the filenames verbatim. This picks up WIRE nodeops, `anvil`, and `solana-test-validator` uniformly.

---

## Installation & Build

From the repo root:

```bash
pnpm install
pnpm --filter @wireio/debugging-client-tool-tui build
```

The `build` script runs `tsc -b` (type-check) then `node esbuild.config.cjs` (bundle). Output lands at:

```
packages/debugging-client-tool-tui/dist/bundle/wire-debugging-client-tool-tui.mjs
```

The bundle is an executable ESM script (shebang + `chmod 0755`) and is registered as the package's `bin`. After `pnpm install`, invoke it either directly, via the workspace alias, or from a cluster directory.

---

## Usage

### Command line

```
wire-debugging-client-tool-tui [--cluster-path|-c <path>] [--features <ids>] [--log-level <level>]
```

| Flag | Default | Description |
|---|---|---|
| `-c`, `--cluster-path <path>` | `process.cwd()` | Absolute path to a cluster directory (must contain `cluster-config.json`). |
| `--features <ids>` | (all) | Comma-separated, case-insensitive feature ids to activate. Required providers are always on. Unknown ids warn to `tui.log`. |
| `--log-level <level>` | `info` | One of `trace`, `debug`, `info`, `warn`, `error`, `fatal`. Root level for every TUI logger category. |

### Examples

Launch against a cluster in the current directory (the common case — run from inside the cluster):

```bash
cd /data/opt/wire/chains/dev-001
wire-debugging-client-tool-tui
```

Launch against an explicit cluster, OPP feature only (still shows process monitor because it's required):

```bash
wire-debugging-client-tool-tui \
  -c /data/opt/wire/chains/dev-001 \
  --features=opp
```

Launch with trace-level logging written to the cluster's TUI log:

```bash
wire-debugging-client-tool-tui -c ./cluster --log-level trace
tail -f ./cluster/data/tui/logs/tui.log
```

### Keybindings

| Key | Context | Action |
|---|---|---|
| `q`, `Esc` | anywhere | Quit the TUI (triggers graceful service teardown). |
| `j` / `k` | Process Monitor panel | Move the cursor down / up through the process list. |
| `Enter` | Process Monitor panel | Open today's log file for the selected process in the Log Viewer. |
| `↑` / `↓` | Log Viewer | Scroll one line. |
| `PgUp` / `PgDn` | Log Viewer | Scroll one viewport. |
| `g` / `G` | Log Viewer | Jump to top / bottom. |
| `F` | Log Viewer | Toggle follow mode (auto-pin to tail). |

---

## Features

The TUI is composed of `FeatureProvider`s. Each owns its panels, status-bar widgets, and lifecycle services, and is either always-on (`isRequiredProvider: true`) or opt-in via `--features`.

### Process Monitor (required — `process-monitor`)

Always-on. Discovers every pid-file-backed process under the cluster, probes liveness, and lets the user drill into each one's log file.

**Panels**
- **Process Monitor** — unified list of cluster processes: WIRE producers / bios / batch operators / underwriters, plus `anvil` and `solana-test-validator` when present. Each row shows liveness glyph (● alive, ✕ dead, … unknown), kind, identifier, `host:port` (for nodeop processes), and pid.
- **Log Viewer** — virtual-scrolled viewer for the selected process's log (`<process-dir>/logs/log_YYYYMMDD.log`). Scrolls arbitrarily large files without buffering them in memory — the `LogTailingService` maintains a byte-offset index and reads only the visible window per render.

**Status bar widget**
- **NodeCountWidget** — `nodes: ALIVE/TOTAL` badge reflecting live process liveness.

**Services**
- **`ProcessMonitorService`** (`dependsOn: [redux]`) — 5-second pid-file scan using `collectPidSources(clusterPath, clusterState)`. Reads each pid file, runs `process.kill(pid, 0)` for a permission-probe liveness check, and dispatches `setProcess` / `removeProcess` actions to Redux.
- **`LogTailingService`** (`dependsOn: [redux, process-monitor]`) — subscribes to `logViewer.path` changes, builds a line-byte-offset index on selection, re-indexes on file growth (200 ms poll), and rebuilds on inode change (log rotation). Exposes `readWindow(from, count)` for panels to pull visible slices. Runtime counters (`totalLines`, `totalBytes`, `indexing`) fan out via `EventEmitter` — not Redux — so polling noise doesn't cause unrelated re-renders.

### OPP Envelope (opt-in — `opp`)

Watches `<cluster-path>/data/opp-debugging/` for envelope writes produced by the embedded debugging server and surfaces per-epoch counts per outpost endpoint.

**Panels**
- **OPP — Epoch Tracker** — header displays epoch duration (from `cluster-config.json`) and current epoch index; body lists every `DebugOutpostEndpointsType` slot with a live envelope count for the latest cached epoch.

**Status bar widget**
- **EpochStatusBarWidget** — `epoch: <current>` badge tracking the highest observed epoch index.

**Services**
- **`OPPTrackingService`** (`dependsOn: [redux]`) — on `start()`, (1) opens `fs.watch` on `data/opp-debugging/` and buffers events, (2) scans existing files to bulk-load via a single `hydrate` dispatch, (3) drains buffered events through `appendEnvelope`. Keys on `.metadata` filesystem events (written after `.data` with an exclusive flag) so there's no half-pair race. Both protobuf payloads are decoded, BigInts stringified, and Uint8Arrays base64-encoded before dispatch — the Redux state stays JSON-safe. Bounded LRU at the `OPPState.MaxEpochs` cap (1000) via insertion-ordered eviction.

---

## Architecture

```
packages/debugging-client-tool-tui/src/
├── logging/LoggingManager.ts            # file-only FileAppender; getLogger guards pre-configure
├── services/                            # lifecycle framework (Service/ServiceType/ServiceManager/ReduxService)
│   └── ServiceContext.tsx               # React Context: ServiceManagerProvider + useService hook
├── store/                               # Redux slices — one subdir per slice
│   ├── StoreTypes.ts                    # enum SliceName + DefaultStatus (leaf, zero imports)
│   ├── Store.ts                         # configureStore + typed hooks
│   ├── ui/ cluster/ features/ opp/ process-monitor/
├── features/
│   ├── FeatureProvider.ts               # interface: id, name, isRequiredProvider, registerComponents, registerServices?
│   ├── FeatureProviderRegistry.ts       # add / all / find
│   ├── opp/
│   │   ├── OPPFeatureProvider.tsx
│   │   ├── OPPTrackingService.ts        # fs.watch + protobuf decode → Redux
│   │   ├── panels/EpochTrackerPanel.tsx
│   │   └── widgets/EpochStatusBarWidget.tsx
│   └── process-monitor/
│       ├── ProcessMonitorFeatureProvider.tsx
│       ├── ProcessMonitorService.ts     # 5s pid-file scan + liveness probe
│       ├── LogTailingService.ts         # line-offset index + readWindow
│       ├── util/                        # PidSources, JsonLogRecord, lineIndex, lineRender, dateStamp
│       ├── panels/{ProcessMonitorPanel,LogViewerPanel,LogViewerJSONLine,LogViewerTextLine,LogViewerSearchInput}.tsx
│       └── widgets/NodeCountWidget.tsx
├── components/
│   ├── VirtualList.tsx                  # generic offset-scroll list (Ink 7 + React 19)
│   └── {PanelComponent,StatusBarComponent}.ts
├── providers/ComponentProviders.ts      # token-keyed registry of Panels + StatusBar widgets
├── bootstrap/                           # pure helpers for main()
├── App.tsx                              # Ink root
├── cli.ts                               # yargs args + cluster loader
└── tui.ts                               # main(): configure logging → register services → boot → render
```

### Key file contracts

| Contract | Where | What |
|---|---|---|
| `cluster-config.json` | `<clusterPath>/` | Ports, paths, binary locations. Loaded by `loadCluster(path)` and dispatched to the cluster slice. |
| `cluster-state.json` | `<clusterPath>/` | Node inventory (producers + batch operators + underwriters). Null before bootstrap completes. |
| `data/<processDir>/<label>.pid` | per-process | Scanned by `collectPidSources` into a unified `PidSource[]`. |
| `data/<processDir>/logs/log_YYYYMMDD.log` | per-process | Opened by `LogTailingService` when selected in the Process Monitor. |
| `data/opp-debugging/<epoch>-<endpoint>-<checksum>.{data,metadata}` | server-written | Decoded by `OPPTrackingService` into Redux. |
| `data/tui/logs/tui.log` | TUI | File-only rolling log (5 MiB × 4 generations). |

---

## Development

```bash
# Incremental TypeScript compile
pnpm --filter @wireio/debugging-client-tool-tui compile:watch

# Dev bundle + auto-restart on rebuild
pnpm --filter @wireio/debugging-client-tool-tui dev

# Unit tests (152 tests, ts-jest)
pnpm --filter @wireio/debugging-client-tool-tui test
```

Tests live at `tests/` mirroring the `src/` tree (e.g. `src/services/ServiceManager.ts` → `tests/services/ServiceManager.test.ts`). Every exported symbol has at least one behavior test — see CLAUDE.md "Unit tests are mandatory" for the policy.

---

## Troubleshooting

- **"Raw mode is not supported on the current process.stdin"** — Ink requires a TTY. Running the binary with piped stdin/stdout/stderr (e.g. in CI without a pseudo-TTY) will fail with this message. Use a real terminal, or `script -q -c wire-debugging-client-tool-tui …` for CI shell captures.
- **"cluster-config.json not found"** — the `--cluster-path` (or cwd) doesn't contain a valid cluster directory. Run `wire-cluster-tool … create` first (see `../cluster-tool/README.md`).
- **Empty Process Monitor panel** — `cluster-state.json` isn't written until bootstrap completes. If the cluster is mid-`create`, wait for it to finish.
- **No OPP data appears** — confirm `--features` includes `opp` (or is omitted entirely), and that envelope `.data`/`.metadata` files are appearing under `<cluster-path>/data/opp-debugging/`. The tracker logs each hydrate/append at `debug` level.
- **Follow mode stuck at a stale position** — press `F` to toggle off and on, or `G` to jump to bottom. Rotation (inode change) is detected automatically; a stale cache would be a bug worth reporting.

---

## Related packages

- **`@wireio/cluster-tool`** (`wire-cluster-tool` CLI) — builds and runs the clusters this TUI debugs. See its README for cluster creation examples and how to chain them with this TUI.
- **`@wireio/debugging-server`** — the in-cluster HTTP server that writes the OPP envelopes this TUI tails.
- **`@wireio/debugging-shared`** — shared types (ports, cluster config/state, endpoint-type reverse maps).
- **`@wireio/debugging-client-shared`** — `JsonRPCClient` + `DebuggingServerClient` for callers that need to talk to the debugging server over HTTP (the TUI currently reads from disk and doesn't require this client, but a future feature may).
