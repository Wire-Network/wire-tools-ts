# Creating a Standalone API Node

This guide covers `wire-cluster-tool create-api-node`: generating the config for
a **standalone WIRE API node** — one that serves the chain's HTTP API and syncs
from peers, with no cluster tree around it and no signing keys.

## Overview

Every other `wire-cluster-tool` command operates on a cluster directory.
`create-api-node` does not: it has no `ClusterConfig`, starts no process, and
touches no chain. It resolves the node's settings, renders its files into
`--output-path`, and exits.

Two files are always written, plus a third when a genesis is supplied:

| Emitted file | Always? | What it is |
|---|---|---|
| `config.ini` | yes | the nodeop config the node reads via `--config-dir` |
| `start.sh` | yes | mode `0755`; `exec`s nodeop against that config |
| `genesis.json` | only with `--genesis-json` | copied in, so the directory stays self-contained |

Because the output is just files, the command is safe to re-run: a second
invocation over the same directory re-renders both artifacts (and keeps
`start.sh` executable).

## Usage

```bash
wire-cluster-tool create-api-node \
  --output-path         /opt/wire/api-node \
  --http-server-address 0.0.0.0:8888 \
  --p2p-peer-address    peer-a.example:9876 \
  --p2p-peer-address    peer-b.example:9876 \
  --genesis-json        /opt/wire/genesis.json
```

## Flags

Flag names follow **nodeop's own option names** wherever one exists, so the ini
line and the flag that produced it read the same.

| Flag | Required | Default | Renders as |
|---|---|---|---|
| `--output-path` | **yes** | — | *(not rendered — the destination directory, created if absent)* |
| `--http-server-address` | **yes** | — | `http-server-address` |
| `--p2p-peer-address` | no | *(none)* | one `p2p-peer-address` line per value — repeat the flag |
| `--chain-state-db-size-mb` | no | `1024` | `chain-state-db-size-mb` |
| `--transaction-finality-status-max-storage-size-gb` | no | `10` | `transaction-finality-status-max-storage-size-gb` |
| `--enable-account-queries` | no | `true` | `enable-account-queries` |
| `--http-max-in-flight-requests` | no | `100` | `http-max-in-flight-requests` |
| `--http-threads` | no | `4` | `http-threads` |
| `--agent-name` | no | `wire-api-node` | `agent-name` |
| `--genesis-json` | no | *(none)* | copied to `<output>/genesis.json`, passed as `--genesis-json` in `start.sh` |

Notes:

- **Defaults have exactly one home.** No flag carries a yargs `default:` — every
  default is applied by `ApiNodeConfig.resolve`, so a programmatic caller and the
  CLI resolve identically. The values above are restated in each flag's
  `--help` text.
- **`--enable-account-queries` is an explicit flag.** Boolean negation is off, so
  turn it off with `--enable-account-queries=false`, not
  `--no-enable-account-queries`.
- **Supplying `--transaction-finality-status-max-storage-size-gb` is what ENABLES
  nodeop's finality-status tracker** — it is a storage budget, not a cap on an
  already-running feature.
- **Endpoints are used VERBATIM.** `--http-server-address` and every
  `--p2p-peer-address` name an arbitrary deployment host. Nothing is bound,
  probed, or claimed against the harness's bind registry — that registry exists
  to keep concurrent clusters on *this* host from colliding, and this command
  starts no listener. The same carve-out a complete external `BindConfig`
  already carries: a remote endpoint's port is not this host's to reserve.

Invalid input fails before anything is written: a missing `--output-path`, an
endpoint that is not `<address>:<port>` (or whose port is outside 1–65535), a
non-positive `--chain-state-db-size-mb`, or a `--genesis-json` that is not on
disk.

## The emitted `config.ini`

```ini
chain-state-db-size-mb = 1024
transaction-finality-status-max-storage-size-gb = 10
enable-account-queries = true
http-max-in-flight-requests = 100
http-threads = 4
agent-name = wire-api-node
http-server-address = 0.0.0.0:8888
p2p-peer-address = peer-a.example:9876
p2p-peer-address = peer-b.example:9876

plugin = sysio::net_plugin
plugin = sysio::chain_api_plugin
plugin = sysio::trace_api_plugin
```

### Why `net_plugin` is in the plugin set

The API-node baseline names `chain_api_plugin` and `trace_api_plugin`.
`net_plugin` is a deliberate addition, for two independent reasons:

1. **`p2p-peer-address` is a `net_plugin` option**, and `chain_api_plugin`'s
   dependency set is only `(chain_plugin)(http_plugin)`. appbase registers the
   options of every compiled-in plugin regardless of which are loaded, so without
   `net_plugin` the peer lines are *accepted and ignored*: nodeop starts clean,
   reports no error, and the node never syncs. A silent no-op is the worst
   failure mode for the one setting that makes an API node useful.
2. **`agent-name` is likewise registered by `net_plugin`** — and the baseline
   sets it. Without the plugin, the baseline configures something it never loads.

Loading `net_plugin` transitively enables `producer_plugin` and
`signature_provider_manager_plugin`. Neither produces anything here: no
`--producer-name` is configured and stale production is off, so the node never
signs a block — exactly how the harness's own operator nodes run. It does not
make this a "producer node" for the public-API hardening rules either: an API
node is that rule's sanctioned non-public exception, which is why it keeps
`trace_api_plugin` and the elevated finality-status storage.

`database-map-mode` is deliberately **not** emitted here — the API-node baseline
governs this file, and the cluster commands' `mapped_private` default is scoped
to their own nodeop argv.

## Starting the node

```bash
cd /opt/wire/api-node
./start.sh
```

`start.sh` resolves the wire-sysio install prefix in precedence order:

1. an explicit `WIRE_PREFIX_PATH` (an operator override always wins);
2. else the parent of a `nodeop` found on `PATH` — an installed host needs no
   configuration at all;
3. else `WIRE_BUILD_PATH`, for a tree still pointed at a build dir.

If none resolves, it fails loudly naming all three. `$NODE_DIR` is derived from
the script's own location, so the directory relocates freely. There is no
`$CLUSTER_DIR`, no `cluster-config.json` probe, and no inline signing key — a
standalone API node signs nothing.

The rendered command is:

```bash
CONDITIONAL_ARGS=()
[[ "$("$WIRE_PREFIX_PATH"'/bin/nodeop' --help 2>/dev/null || true)" == *'--trace-no-abis'* ]] && CONDITIONAL_ARGS+=('--trace-no-abis')

exec "$WIRE_PREFIX_PATH"'/bin/nodeop' \
  --config-dir "$NODE_DIR" \
  --data-dir "$NODE_DIR"'/data' \
  --genesis-json "$NODE_DIR"'/genesis.json' \
  "${CONDITIONAL_ARGS[@]}"
```

(`--genesis-json` appears only when a genesis was supplied.)

### The `--trace-no-abis` capability probe

This node loads `trace_api_plugin`, and the flag that plugin needs is **not the
same across nodeop generations**: newer builds hard-fail its init WITHOUT
`--trace-no-abis`, while older builds reject the unknown option WITH it. The
harness supplies no trace-api ABI set, so raw traces are the right answer either
way — the only question is whether this nodeop understands the flag.

`create-api-node` never sees a nodeop binary (that is the point: it emits files
and exits), and even a build-time answer would be the *generating* host's, not
the deploy host's. So the answer is computed at run time: `start.sh` captures the
resolved nodeop's `--help` and appends the flag to `CONDITIONAL_ARGS` only when
it appears. This is the same probe a cluster node's `start.sh` carries, rendered
from the same code.

The capture-then-match shape is deliberate — `--help | grep -q` would break under
`set -o pipefail`: `grep -q` exits the instant it matches, closing the pipe, and
nodeop's help exceeds the 64 KiB pipe buffer, so nodeop dies of `SIGPIPE` and
`pipefail` promotes that to the pipeline's status. The `&&` would then NOT fire —
dropping the flag precisely when it IS supported.

## Genesis and the data directory

The two are alternatives, and the node needs exactly one of them:

- **`--genesis-json`** — for a node syncing a chain from block 1. The file is
  copied to `<output>/genesis.json` and passed on every start.
- **A pre-populated `--data-dir`** — for a node restored from a snapshot or an
  existing state directory. Omit `--genesis-json`; the emitted `start.sh` then
  carries no genesis argument at all.

`<output>/data` is **not** pre-created — nodeop creates it on first start — so
staging a snapshot there beforehand is simply a matter of putting it in place.
