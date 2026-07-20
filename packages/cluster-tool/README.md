# @wireio/cluster-tool

Core library and CLI for creating, running, and tearing down multi-chain WIRE
test clusters. Ships the `wire-cluster-tool` binary, the declarative
orchestration engine (`ClusterBuildPhaseGroup` → `ClusterBuildPhase` →
`ClusterBuildStep` → `Report`) shared by the CLI and every `flow-*`, process
managers for every cluster component, and typed clients for WIRE / Ethereum /
Solana.

- **Binary:** `wire-cluster-tool` (alias `wtc`)
- **Stack:** Node ≥22, `child_process.spawn` + `tree-kill` (no pm2), `ethers`,
  `@solana/web3.js`, `@coral-xyz/anchor`
- **Persisted shapes** are zod schema-first (`@wireio/cluster-tool-shared`) —
  every serialize/deserialize goes through the generic `SchemaCodec`.
- **Companion UI:** `@wireio/debugging-client-tool-tui` — non-destructive live
  debugger, see ["Debugging a running cluster"](#debugging-a-running-cluster).

---

## Overview

A "cluster" is an on-disk directory plus the long-running processes that operate
on it. `wire-cluster-tool` owns the full lifecycle:

| Command | What it does |
|---|---|
| `create` | Resolve config, build the directory layout, generate keys + genesis + node configs, bootstrap every chain (WIRE system contracts, OPP contracts on anvil, `opp-outpost` on solana), persist `cluster-config.json` / `cluster-state.json` / `cluster-keys.json`, then exit. |
| `run` | Rehydrate keys from `cluster-keys.json`, RE-DERIVE topology from the config (never a stored launch command), relaunch `kiod` + every node, gate on liveness, block until Ctrl+C. |
| `destroy` | Stop every process, best-effort clean up published SSM keys, remove the cluster directory. |
| `package` | Archive each node's full config tree (+ `genesis.json`) into `<cluster>/packages/<node>.<ext>` — the multihost hand-off artifact (post-`create`). |
| `create-external-config` | Clone a created, stopped local cluster into a deployable external directory with a different `BindConfig` merged in + emit its self-described `external-cluster-config.json`. |

The cluster directory is the **single source of truth**: executable paths,
ports, key material, node layout, deployed contract addresses. `run` never
re-resolves ports or re-derives keys from scratch — it replays the persisted
config and re-derives the node topology deterministically via
`NodeConfig.plan(config)`, the exact call `create`'s steps make.

### What gets spawned

- `kiod` — WIRE wallet daemon.
- One `nodeop` per bios / producer / batch-operator / underwriter node.
- `anvil` — the local Ethereum outpost (omitted in external-outpost mode).
- `solana-test-validator` — the local Solana outpost (omitted in
  external-outpost mode; each cluster gets a disjoint `--dynamic-port-range`).
- An **embedded debugging HTTP server** (JSON-RPC 2.0) that persists OPP
  envelopes under `<cluster-path>/data/opp-debugging/`. In-process — no binary.

Every spawned process writes a pid file and its stdout/stderr into the cluster's
`logs/` + per-node dirs — the layout the TUI consumes.

---

## Install & Build

From the repo root:

```bash
pnpm install
pnpm --filter @wireio/cluster-tool build
```

The `wire-cluster-tool` bin is linked into `node_modules/.bin/`. Invoke via
`pnpm exec wire-cluster-tool …` or `pnpm wire-cluster-tool …`.

---

## CLI reference

The command comes FIRST; every option follows it
(`wire-cluster-tool <command> --flag …`). `create` exposes every
`ClusterBuildOptions` leaf as a `--kebab-path` flag via the SAME
`applyClusterBuildOptionsArgs` surface every flow uses; `WIRE_*` env vars seed
the path flags.

### `create`

| Flag | Alias | Default | Notes |
|---|---|---|---|
| `--cluster-path` | `-d` | **required** | cluster data directory + `cluster-config.json` |
| `--build-path` | | **required** | `wire-sysio` build dir (with `bin/nodeop`) |
| `--ethereum-path` | | **required** | `wire-ethereum` repo (anvil + outpost deploy) |
| `--solana-path` | | **required** | `wire-solana` repo (`solana-test-validator` + `opp-outpost`) |
| `--force` | | `false` | overwrite an existing cluster directory |
| `--node-count` | `-n` | `1` | producer node **processes** |
| `--producer-count` | `-p` | `21` | producer **accounts** registered on-chain |
| `--batch-operator-count` | `-b` | `3` | batch operators |
| `--underwriter-count` | `-u` | `1` | underwriters |
| `--epoch-duration-sec` | | `60` | minimum epoch duration (the depot floor) |
| `--warmup-epochs` / `--cooldown-epochs` | | `1` / `1` | operator WARMUP → ACTIVE / COOLDOWN → deregister windows |
| `--terminate-max-consecutive-misses` / `--terminate-max-percent-misses24h` / `--terminate-window-ms` | | — | termination tuning |
| `--bind-all` | | `false` | bind every daemon to `0.0.0.0` instead of loopback |
| `--bind-*` | | auto | per-daemon address/port pins (`--bind-anvil-port`, …); unpinned ports are auto-assigned collision-free |
| `--bind-config <file>` | | — | a `BindConfig` JSON: complete → verbatim (no probing), partial → merged over resolved defaults (CLI > file > defaults) |
| `--external-outpost-config <file>` | | — | bootstrap the depot against already-deployed REMOTE ETH+SOL outposts |
| `--signature-provider-type` | | `KEY` | `KEY` (inline) / `SSM` / `KIOD` |
| `--signature-provider-ssm '<json>'\|<file>` | | — | SSM region + secret-id pattern (required for `SSM`) |
| `--logging-levels-console` / `--logging-levels-file` | | `info` / `debug` | per-sink log levels |
| `--report-path` / `--report-basename` | | `<cluster>/reports`, `cluster-build` | Report output |

### `run` / `destroy`

Both take only `--cluster-path` (`-d`). `run` blocks until Ctrl+C (clean
shutdown); `destroy` stops every daemon, deletes published SSM keys under the
`SSM` provider (best-effort), and removes the directory.

### `package`

```bash
wire-cluster-tool -d <cluster-dir> package --package-type zip   # case-insensitive
```

One self-contained archive per node under `<cluster>/packages/<node>.zip` (the
node's full tree + the shared `genesis.json`). `--package-type` is required
(`zip` today; `ClusterPackageType` + its per-type backend is the extension
seam). Runs only on a successfully-`create`d, STOPPED cluster. Under the default
`KEY` provider a node's `config.ini` embeds its signing keys, so archives are
sensitive; `cluster-keys.json` is NEVER archived.

### `create-external-config`

```bash
wire-cluster-tool create-external-config \
  --local-cluster-path    /opt/wire/testnet-local \
  --external-cluster-path /opt/wire/testnet \
  --external-bind-config  ~/testnet-bind-config.json
```

Clones a created, STOPPED local cluster into a fresh deployable directory
(`--external-cluster-path` must be empty or non-existent) with the external
`BindConfig` merged in, and emits `external-cluster-config.json`. Five Report
stages: **Validate** (topology-compatible bind — cardinality, node mapping,
operator accounts, no duplicate ports, sane solana dynamic range; fails fast
before any write) → **Clone** (copy the tree, excluding `*.pid` / `logs/` /
`reports/`, preserving `cluster-keys.json`'s 0600) → **Rebind** (re-render every
config file from the merged, external-rooted model — never text-patched) →
**Emit** → **Verify** (scan for stale local ports + round-trip the emitted JSON).

---

## Usage examples

```bash
# Full three-chain cluster (WIRE + ETH + SOL), default topology:
wire-cluster-tool create -d /opt/wire/dev-full --force \
  --build-path    <wire-sysio>/build/release \
  --ethereum-path <wire-ethereum> \
  --solana-path   <wire-solana> \
  --epoch-duration-sec 60

# Start it (blocks until Ctrl+C):
wire-cluster-tool run -d /opt/wire/dev-full

# Package it, then tear it down:
wire-cluster-tool -d /opt/wire/dev-full package --package-type zip
wire-cluster-tool destroy -d /opt/wire/dev-full
```

SSM-keyed cluster, then export a deployable external config from it (single
cluster: `create` publishes keys to AWS SSM, `create-external-config` clones it):

```bash
# 1. Create — keys published to AWS SSM (needs AWS credentials at create time):
wire-cluster-tool create \
  --cluster-path  /opt/wire/testnet-local \
  --build-path    <wire-sysio>/build/release \
  --ethereum-path <wire-ethereum> \
  --solana-path   <wire-solana> \
  --signature-provider-type SSM \
  --signature-provider-ssm '{"awsRegion":"us-east-1","awsSecretIdPattern":"/wire-sysio/{cluster}/keys/{account}/{keyType}"}'
# ids render as e.g. /wire-sysio/testnet-local/keys/batchop.a/K1
# ({cluster} = basename of --cluster-path); specs render SSM:us-east-1:<id>.

# 2. Stop it, then clone into a deployable external directory (remote bind merged in):
wire-cluster-tool create-external-config \
  --local-cluster-path    /opt/wire/testnet-local \
  --external-cluster-path /opt/wire/testnet \
  --external-bind-config  ~/testnet-bind-config.json
# emitted external-cluster-config.json carries SSM providers (awsSecretId refs,
# reconstructed from the pattern) — NO plaintext keys.
```

External-outpost cluster (remote ETH+SOL): pass `--external-outpost-config` +
a `--bind-config` whose `anvil` / `solana` addresses are the remote RPC
endpoints; `create` verifies `eth_chainId` / Solana `getVersion` and gates on
head-block advance (not epoch distribution). See the repo root README's
"External outpost clusters" section.

---

## Debugging a running cluster

Once `wire-cluster-tool run` is live in one terminal, use the sibling
**`wire-debugging-client-tool-tui`** TUI in a second terminal to observe it. The
TUI reads the same on-disk layout — `cluster-config.json`, `cluster-state.json`,
per-process pid files + logs, and OPP envelopes under `data/opp-debugging/` — so
there is zero extra setup.

```bash
# Terminal 1: run the cluster
wire-cluster-tool run -d /opt/wire/dev-full
# Terminal 2: watch it live (defaults --cluster-path to cwd)
wire-debugging-client-tool-tui --cluster-path /opt/wire/dev-full
```

- **Process Monitor** — every pid-backed process with a liveness glyph, refreshed
  every 5 s; `Enter` opens that process's log.
- **Log Viewer** — virtual-scrolled reader with follow mode + rotation detection.
- **OPP Epoch Tracker** — live per-direction envelope counts for the most recent
  epochs (watches `data/opp-debugging/`).

See `packages/debugging-client-tool-tui/README.md` for the full keybinding
reference.

---

## Cluster directory layout

After `create`:

```
<cluster-path>/
├── cluster-config.json           # resolved config (paths, ports, binaries, signatureProvider, externalOutposts)
├── cluster-state.json            # node topology snapshot (re-derivable via NodeConfig.plan)
├── cluster-keys.json             # 0600 — producer node key sets + every operator account's keys
├── genesis.json                  # shared chain genesis
├── external-cluster-config.json  # ONLY in a create-external-config output dir
├── wallet/                       # kiod wallet
├── reports/                      # Report renders (csv / md / html)
├── logs/                         # cluster-wide aggregate log
├── packages/                     # per-node archives (after `package`)
└── data/
    ├── node_bios/  node_00/ …    # per-node dirs (config.ini, logging.json, blocks/, state/, *.pid)
    ├── anvil/                    # anvil state          (local ETH outpost only)
    ├── solana-ledger/            # validator ledger      (local SOL outpost only)
    ├── eth-abis/                 # address-embedded outpost ABIs
    ├── solana-idls/              # liqsol_core (opp-outpost) IDL
    ├── ethereum-deployments/     # outpost-addrs.json
    └── opp-debugging/            # OPP envelope .data / .metadata pairs
```

In external-outpost mode no local `anvil` / `solana-ledger` state is written
(`cluster-state.json` records them as `null`); the operator-daemon artifacts come
from the `--external-outpost-config` instead.

---

## Programmatic usage

For flow tests and custom tooling the harness exports the orchestration engine,
the process/cluster managers, the chain clients, and the config providers:

```ts
import {
  ClusterBuildDefaults,   // registers the ~40-phase bootstrap
  ClusterManager,         // create / run / destroy / stop (namespace fns)
  ClusterConfigProvider,  // resolve options → validated ClusterConfig
  ClusterState,           // capture / save / load / rehydrate the snapshot + keys
  Steps                   // the declarative Steps palette (plan* factories)
} from "@wireio/cluster-tool"
import { WireClient } from "@wireio/cluster-tool/clients/wire"

// Build + run the default bootstrap, producing a Report:
const build = await ClusterBuildDefaults.create({
  clusterPath: "/opt/wire/dev",
  buildPath: "<wire-sysio>/build/release",
  ethereumPath: "<wire-ethereum>",
  solanaPath: "<wire-solana>"
})
const report = await build.build()   // one Report.StepResult per Step
```

Persisted shapes + their validated codecs live in `@wireio/cluster-tool-shared`
(`ClusterConfig` / `BindConfig` / `ClusterState` / `SignatureProviderConfig` /
`ExternalOutpostConfig` / `ExternalClusterConfig`, each a `z.infer` of a zod
schema behind `SchemaCodec.create<T>(schema)`).

A flow is a `FlowScenario` composed onto the same engine via
`FlowCLI.create(<Name>Scenario).run()`. See the 13 `flow-*` packages —
`flow-operator-collateral-deposit`, `flow-batch-operator-slashing`,
`flow-batch-operator-termination`, the six `flow-swap-*` variants,
`flow-reserves-*`, `flow-emissions-soak`, `flow-node-owner-nft`,
`flow-yield-distribution` — for end-to-end examples.

---

## Development

```bash
pnpm --filter @wireio/cluster-tool compile:watch   # incremental type-check
pnpm --filter @wireio/cluster-tool test            # jest unit tests
pnpm --filter @wireio/cluster-tool format          # prettier
```

Any new or modified symbol ships with unit tests in the same commit (see the
repo `CLAUDE.md` / `STYLE.md`).

---

## Troubleshooting

- **`create` / `run` port conflicts** — ports are resolved collision-free via a
  cross-process registry; a stale daemon from a prior run can still hold one.
  Check `pgrep -a nodeop` and clean up, or `destroy` the old cluster.
- **`--signature-provider-type SSM` fails at create** — publishing writes to AWS
  SSM Parameter Store and needs valid AWS credentials in the environment; the
  logged error carries the parameter id + region (never the secret value).
  `destroy` deletes the published keys best-effort.
- **`--bind-config` rejected** — the file failed validation: a complete
  `BindConfig` must match the cluster topology (one entry per node/role); a
  remote `anvil`/`solana` address requires `--external-outpost-config`. The error
  names the exact mismatch.
- **`package` / `create-external-config` refuse to run** — both require a
  successfully-`create`d, STOPPED cluster; stop every daemon first
  (`create-external-config` additionally requires an empty/non-existent
  `--external-cluster-path`).
- **outpost bootstrap can't find artifacts** — build `wire-ethereum`
  (Hardhat artifacts) and `wire-solana` (`anchor build` → `.so` + IDL) first.

---

## Related packages

- **`@wireio/cluster-tool-shared`** — zod schema-first persisted shapes + the
  `SchemaCodec` validation surface.
- **`@wireio/debugging-client-tool-tui`** — live debugging UI for a running cluster.
- **`@wireio/debugging-server`** — the embedded JSON-RPC server that persists OPP envelopes.
- **`@wireio/debugging-shared`** — shared OPP debugging types + storage paths.
- **`flow-*` (13 packages)** — end-to-end scenarios built on `FlowCLI` + this engine.
