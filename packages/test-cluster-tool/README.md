# @wireio/test-cluster-tool

Core library and CLI for creating, running, and tearing down multi-chain WIRE test clusters. Ships the `wire-test-cluster` binary, process managers for every cluster component, and typed clients for WIRE / Ethereum / Solana.

- **Binary:** `wire-test-cluster`
- **Stack:** Node ≥22, `child_process.spawn` + `tree-kill` (no pm2), `ethers`, `@solana/web3.js`, `@coral-xyz/anchor`
- **Companion UI:** `@wireio/debugging-client-tool-tui` (`wire-debugging-client-tool-tui` bin) — non-destructive live debugger, see ["Debugging a running cluster"](#debugging-a-running-cluster) below.

---

## Overview

A "cluster" is an on-disk directory plus the long-running processes that operate on it. `wire-test-cluster` owns the full lifecycle:

| Command | What it does |
|---|---|
| `create` | Build the directory layout, generate keys + genesis + configs, bootstrap every chain (WIRE system contracts, OPP contracts on Anvil, Anchor program on Solana), persist `cluster-state.json`, then exit. |
| `run` | Reload `cluster-state.json`, relaunch every managed process from its saved launch command, expose all endpoints, block until Ctrl+C. |
| `destroy` | Stop every process, then remove the cluster directory. |

The cluster directory is the **single source of truth**: executable paths, ports, key material, node layout, and deployed contract addresses all live there. Subsequent `run`s never re-resolve — they just replay.

### What gets spawned

Per cluster:

- `kiod` — WIRE wallet daemon
- One `nodeop` per producer / bios / batch-operator / underwriter node
- `anvil` (optional — enabled by `--ethereum-path`)
- `solana-test-validator` (optional — enabled by `--solana-path`)
- An **embedded debugging HTTP server** (Express + JSON-RPC 2.0) that persists OPP envelopes under `<cluster-path>/data/opp-debugging/`. Runs in-process — no separate binary.

Every spawned process writes a pid file (`<dataPath>/<label>.pid`) and a rotating daily log (`<dataPath>/logs/log_YYYYMMDD.log`) — the layout the TUI consumes.

---

## Install & Build

From the repo root:

```bash
pnpm install
pnpm --filter @wireio/test-cluster-tool build
```

After this the `wire-test-cluster` bin is linked into `node_modules/.bin/`. Invoke via `pnpm exec wire-test-cluster …` or the workspace-wide `pnpm wire-test-cluster …`.

---

## CLI reference

```
wire-test-cluster [global-options] <command> [command-options]
```

### Global options

| Flag | Type | Default | Notes |
|---|---|---|---|
| `-d`, `--cluster-path <path>` | string | **required** | Absolute directory for cluster data. Created if missing. |
| `--force` | boolean | `false` | When combined with `create`, remove the existing directory first. |

### `create` options

| Flag | Default | Notes |
|---|---|---|
| `--build-path <path>` | **required** | Path to the `wire-sysio` build directory (contains `bin/nodeop`, `bin/kiod`, etc.). |
| `-p`, `--pnodes <n>` | `1` | Producer nodes. |
| `-n`, `--nodes <n>` | `0` | Additional non-producer nodes. |
| `--prod-count <n>` | `21` | Producers to register on-chain. |
| `-s`, `--topology <mesh\|ring\|star>` | `mesh` | P2P topology between nodes. |
| `--http-secure` | `false` | Use HTTPS for node RPC endpoints. |
| `-b`, `--batch-operator-count <n>` | `3` | Batch-operator nodes (range 3–21). |
| `-u`, `--underwriter-count <n>` | `1` | Underwriter nodes (range 1–100). |
| `--epoch-duration-sec <n>` | `360` | Seconds per epoch. |
| `--warmup-epochs <n>` | `1` | Epochs before an operator transitions WARMUP → ACTIVE. |
| `--cooldown-epochs <n>` | `1` | Epochs before an operator can deregister after COOLDOWN. |
| `--ethereum-path <path>` | *(omitted)* | Path to the `wire-ethereum` repo. Enables Anvil + OPP-contract deployment. |
| `--solana-path <path>` | *(omitted)* | Path to the `wire-solana` repo. Enables `solana-test-validator` + Anchor program deploy. |

### `run` / `destroy` options

Both commands take no additional flags — they operate on the directory supplied via `--cluster-path`.

---

## Usage examples

### Minimal single-chain cluster (WIRE only)

Bootstrap one producer node with 21 registered producers, no outposts:

```bash
wire-test-cluster \
  --cluster-path /data/opt/wire/chains/dev-001 \
  --force \
  create \
    --build-path /data/shared/code/wire/wire-sysio/build
```

Then launch it:

```bash
wire-test-cluster --cluster-path /data/opt/wire/chains/dev-001 run
```

Ctrl+C triggers the registered `SIGINT` handler, which calls `ClusterManager.stop()` → `ProcessManager.killAll()` → embedded debugging server shutdown.

### Full three-chain cluster (WIRE + ETH + SOL)

With default counts (1 producer / 3 batch operators / 1 underwriter) and both outposts:

```bash
wire-test-cluster \
  --cluster-path /data/opt/wire/chains/dev-full \
  --force \
  create \
    --build-path         /data/shared/code/wire/wire-sysio/build \
    --ethereum-path      /data/shared/code/wire/wire-ethereum \
    --solana-path        /data/shared/code/wire/wire-solana \
    --batch-operator-count 3 \
    --underwriter-count    1 \
    --epoch-duration-sec   60
```

Run:

```bash
wire-test-cluster --cluster-path /data/opt/wire/chains/dev-full run
```

The `create` step performs, in order:
1. Directory prep + port resolution (persisted into `cluster-config.json`).
2. Bios + producer node spin-up; WIRE system contract deployment.
3. OPP contract deployment on Anvil (if `--ethereum-path`).
4. `solana-test-validator` launch + `opp-outpost` program init (if `--solana-path`).
5. Batch-operator + underwriter node spin-up with outpost client args injected.
6. Cross-chain handshake + `cluster-state.json` write.
7. Clean shutdown of every spawned process — the cluster is ready to `run`.

### Dense cluster for stress testing

```bash
wire-test-cluster \
  --cluster-path /data/opt/wire/chains/stress-01 \
  --force \
  create \
    --build-path /data/shared/code/wire/wire-sysio/build \
    -p 3 -n 2 \
    --prod-count 21 \
    -b 21 \
    -u 25 \
    --topology mesh \
    --epoch-duration-sec 30
```

### Running existing clusters

Already created, just want to start it:

```bash
wire-test-cluster --cluster-path /data/opt/wire/chains/dev-full run
```

Tear it down and reclaim disk:

```bash
wire-test-cluster --cluster-path /data/opt/wire/chains/dev-full destroy
```

---

## Debugging a running cluster

Once `wire-test-cluster … run` is live in one terminal, use the sibling **`wire-debugging-client-tool-tui`** TUI in a second terminal to observe it. The TUI reads the same on-disk layout — `cluster-config.json`, `cluster-state.json`, per-process pid files, per-process logs, and OPP envelopes under `data/opp-debugging/` — so there is zero extra setup.

```bash
# Terminal 1: run the cluster
wire-test-cluster --cluster-path /data/opt/wire/chains/dev-full run

# Terminal 2: watch it live
wire-debugging-client-tool-tui --cluster-path /data/opt/wire/chains/dev-full
```

Or just `cd` into the cluster directory first — `wire-debugging-client-tool-tui` defaults `--cluster-path` to `process.cwd()`:

```bash
cd /data/opt/wire/chains/dev-full
wire-debugging-client-tool-tui
```

### What the TUI surfaces

- **Process Monitor panel** — every pid-file-backed process (WIRE producers / bios / batch operators / underwriters, plus `anvil` and `solana-test-validator` when present) with a liveness glyph (● alive / ✕ dead / … unknown) refreshed every 5 seconds. Arrow through the list with `j`/`k`; press `Enter` to open that process's log in the Log Viewer.
- **Log Viewer panel** — virtual-scrolled reader for today's `log_YYYYMMDD.log` of the selected process. `↑` / `↓` / `PgUp` / `PgDn` scroll, `g` / `G` jump to top/bottom, `F` toggles follow mode (auto-pin to tail). Rotation (inode change) is detected automatically and the index rebuilds.
- **OPP Epoch Tracker panel** — live envelope counts per `DebugOutpostEndpointsType` slot for the most recent epoch, plus total cached-epoch depth (bounded LRU at 1000). Populated by watching `data/opp-debugging/` for the debugging server's envelope writes.
- **Status bar** — `nodes: ALIVE/TOTAL` badge and `epoch: <current>` badge.

### Focused debugging

Activate only the OPP feature (Process Monitor is required and stays on regardless):

```bash
wire-debugging-client-tool-tui -c /data/opt/wire/chains/dev-full --features=opp
```

Crank log verbosity and tail the TUI's own log in a third terminal:

```bash
wire-debugging-client-tool-tui -c /data/opt/wire/chains/dev-full --log-level=trace &
tail -f /data/opt/wire/chains/dev-full/data/tui/logs/tui.log
```

The TUI writes file-only (no console output — Ink would corrupt), so `tui.log` is the canonical place to investigate TUI behavior.

See `packages/debugging-client-tool-tui/README.md` for the full feature breakdown and keybinding reference.

---

## Cluster directory layout

After `create` completes:

```
<cluster-path>/
├── cluster-config.json              # ports, paths, binary locations (immutable after create)
├── cluster-state.json               # node inventory + launch commands (rewritten each create)
└── data/
    ├── node_bios/                   # bios node data dir (blocks/, state/, logs/, *.pid)
    ├── node_00/ … node_NN/          # producer nodes
    ├── node_batchop_00/ …           # batch-operator nodes
    ├── node_uwrit_00/ …             # underwriter nodes
    ├── anvil/                       # anvil state + pid + logs (if --ethereum-path)
    ├── solana_validator/            # solana-test-validator ledger + pid + logs (if --solana-path)
    ├── eth-abis/                    # deployed contract ABIs (OPP, OPPInbound, BAR)
    ├── solana-idls/                 # Anchor IDLs (opp_outpost.json)
    ├── opp-debugging/               # envelope .data/.metadata pairs (debugging server writes)
    └── tui/logs/                    # wire-debugging-client-tool-tui writes here (see companion)
```

Every managed process writes `<dataPath>/<label>.pid` (e.g. `data/node_00/node-00.pid`) on spawn and removes it on clean exit. The TUI's Process Monitor iterates these.

---

## Programmatic usage

For flow tests and custom tooling, the harness exports `ClusterManager`, the process managers, the chain clients, and the typed configuration:

```ts
import {
  ClusterManager,
  ClusterPorts,
  ProcessManager,
  WIREClient,
  ETHClient,
  SOLClient,
  Clio
} from "@wireio/test-cluster-tool"

const config = await ClusterManager.resolveExePaths("/path/to/wire-sysio/build")
// …build ClusterConfig, then:
const manager = new ClusterManager(clusterConfig).loadState()
await manager.startAndWait()
```

See the `flow-empty-epoch-balance-sheet` / `flow-operator-collateral-deposit` / `flow-swap-with-underwriting` / `flow-collateral-deposit-via-bar` / `flow-batch-operator-termination` / `flow-swap-variance-revert` packages for end-to-end test examples that drive full scenarios against a harness-built cluster.

---

## Development

```bash
# Incremental type-check
pnpm --filter @wireio/test-cluster-tool compile:watch

# Unit tests
pnpm --filter @wireio/test-cluster-tool test

# Prettier
pnpm --filter @wireio/test-cluster-tool format
```

Any new or modified function / class / module ships with unit tests in the same commit — see CLAUDE.md "Unit tests are mandatory for every new or modified symbol".

---

## Troubleshooting

- **`create` hangs on "waiting for node_00 to sync"** — most commonly a stale `nodeop` process from a prior run. `ProcessManager` `pkill`s known binaries on its own initialization, but a fresh shell may not see leftover children. Check with `pgrep -a nodeop` and clean up manually if needed.
- **`run` fails with "port N in use"** — a previous cluster on the same machine wasn't fully destroyed. `destroy` calls `killAll` + `rm -rf`, but you can force-clean with `pkill nodeop; pkill kiod; pkill anvil; pkill solana-test-validator` and then `rm -rf <cluster-path>`.
- **`--ethereum-path` bootstrap errors out on missing artifacts** — run `pnpm --filter @wireio/wire-ethereum build` in the `wire-ethereum` repo first so the OPP contract artifacts exist.
- **`--solana-path` bootstrap can't find `opp_outpost.so`** — build the Anchor program first (`anchor build`) in the `wire-solana` repo. The harness copies the `.so` + IDL into `<cluster-path>/data/solana-idls/` at bootstrap time.
- **Can't tell what's dead in a running cluster** — launch the TUI (see ["Debugging a running cluster"](#debugging-a-running-cluster)). The Process Monitor panel flags every dead pid within 5 seconds.

---

## Related packages

- **`@wireio/debugging-client-tool-tui`** — live debugging UI for the cluster this harness builds. `cd` into any cluster directory and run `wire-debugging-client-tool-tui`.
- **`@wireio/debugging-server`** — HTTP / JSON-RPC 2.0 server embedded inside `ClusterManager` that persists OPP envelopes.
- **`@wireio/debugging-shared`** — shared types (ports, cluster config/state, endpoint enums) consumed by both the harness and its clients.
- **`@wireio/flow-{a,b,c,d}`** — end-to-end test flows that drive the harness-built cluster through specific scenarios.
