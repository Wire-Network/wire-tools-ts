# Setting up an External Cluster

This guide covers the `wire-cluster-tool` **create-side** workflow: turning a
locally-created WIRE test cluster into a **deployable "external" cluster** — one
whose depot (nodeop fleet + kiod) and outpost RPC endpoints live at addresses you
choose (static IPs, remote hosts, container aliases), ready to run on a multihost
environment (S3/EC2, GCS, a `docker compose` stack, …) or to be verified locally
in Docker.

## Overview

Two commands drive it:

| Command | What it does |
|---|---|
| `create` | Bootstrap a local cluster (the source) — depot + both outposts. |
| `create-external-config` | Clone that cluster into a deployable directory with an **external `BindConfig`** merged in, emitting a self-described `external-cluster-config.json`. |
| `run` | Start a created (local **or** external) cluster from its persisted state. |
| `package` | Per-node archives of the external cluster for hand-off to a multihost environment. |

Plus the Docker verification harness under `scripts/external/`.

The guiding principle: **the emitted external directory is fully self-described.**
Every address, port, key, and artifact an external run needs is either persisted
in `cluster-config.json` (`ClusterConfig.bind`, keys, paths) or referenced by the
emitted `external-cluster-config.json`. Consumers read from *that* directory — not
from the original local cluster.

## Prerequisites

- A built **wire-sysio** — `nodeop` / `kiod` / `clio` under `<wire-sysio>/build/<dir>/bin`.
- **wire-ethereum** + **wire-solana** checkouts (needed for the local `create`).
- Node ≥ 22 + pnpm; run `pnpm build` in `wire-tools-ts`.
- Host toolchains (for `create` and the Docker verify): **Foundry** (`anvil`) and
  **Agave** (`solana-test-validator`) on `PATH`. The Docker image pins to *your
  host's* versions — a mismatch breaks cloned-state loading.
- **Docker** + **docker compose** (for the verification harness only).

## Step 1 — Create a local cluster

```bash
wire-cluster-tool create \
  --cluster-path  /path/to/local \
  --build-path    <wire-sysio>/build/debug \
  --ethereum-path <wire-ethereum> \
  --solana-path   <wire-solana>
```

This bootstraps the depot + both outposts (anvil = ETH, solana = SOL) and
persists into `--cluster-path`:

- `cluster-config.json` — the resolved config (bind, topology, paths, …).
- `cluster-state.json` — secret-free topology snapshot.
- `cluster-keys.json` — the signing keys (mode `0600`).
- Deployed outpost artifacts — `data/eth-abis/`,
  `data/ethereum-deployments/outpost-addrs.json`, `data/solana-idls/`, the anvil
  dump (`data/anvil/anvil.json`), and the solana ledger (`data/solana-ledger/`).

**Signature providers** (how the cluster's own signing keys are handled):

```bash
  --signature-provider-type <KEY|SSM|KIOD>              # default KEY
  --signature-provider-ssm  '{"awsRegion":"us-east-1","awsSecretIdPattern":"/wire/{cluster}/{account}/{keyType}"}'
```

`--signature-provider-ssm` also accepts a **file path** (any value not starting
with `{`). SSM publishes each generated key to AWS Secrets Manager at create time
(requires AWS credentials).

> **Stop the cluster before Step 3.** `create-external-config` requires a stopped
> cluster so it clones a consistent copy.

## Step 2 — Author the external BindConfig

The external `BindConfig` is a JSON file giving each daemon the address + port it
will bind/dial in the target environment. For a `docker compose` (or any
static-IP) deployment, use **static IPv4 addresses in one subnet**:

```json
{
  "kiod":            { "address": "192.168.219.10", "port": 8910 },
  "nodeop": {
    "address": "192.168.219.10",
    "ports": {
      "bios":         { "http": 8788, "p2p": 8776 },
      "producers":    [{ "http": 8888, "p2p": 8887 }],
      "batch":        [{ "http": 8811, "p2p": 8812 }, { "http": 8813, "p2p": 8814 }, { "http": 8815, "p2p": 8816 }],
      "underwriters": [{ "http": 8817, "p2p": 8818 }]
    }
  },
  "anvil":           { "address": "192.168.219.20", "port": 8545 },
  "solana":          { "address": "192.168.219.30", "ports": { "http": 8899, "faucet": 8890, "gossip": 8001, "dynamicRange": { "first": 8100, "last": 8163 } } },
  "debuggingServer": { "address": "192.168.219.10", "port": 8991 }
}
```

- The depot-side daemons (nodeop nodes, kiod, debugging server) typically **share
  one address** (one host/container) on distinct ports.
- anvil and solana each get **their own address** (separate hosts/containers).
- **Cardinality must match the local topology**: `nodeop.ports.producers` /
  `batch` / `underwriters` lengths must equal the local cluster's producer /
  batch-operator / underwriter counts. `create-external-config` validates this and
  fails fast with a precise error otherwise.

## Step 3 — create-external-config

```bash
wire-cluster-tool create-external-config \
  --local-cluster-path    /path/to/local \
  --external-cluster-path /path/to/external \   # MUST be empty or non-existent
  --external-bind-config  /path/to/bind.json \
  [--no-debugging-server]
```

Runs a five-stage pipeline (each stage a validated Report step):

1. **Validate** — the external bind against the local topology (node mapping,
   operator accounts, cardinality, dynamic-range sanity, no duplicate ports).
2. **Clone** — copy the cluster tree, excluding runtime artifacts (`*.pid`,
   `logs/`, `reports/`, and non-copyable inodes like stale unix sockets).
3. **Rebind** — re-render `cluster-config.json`, `genesis.json`, per-node
   `config.ini` / `logging.json`, and `cluster-state.json` from the **merged
   model** (external bind addresses + external root paths). Never text-patched.
4. **Emit** — write `external-cluster-config.json` (self-described: `bindings`,
   `accounts` + per-key-type key providers, `wire.epochDurationSec`, and the
   ethereum/solana outpost references).
5. **Verify** — scan the external tree for any leaked local-bind address/port +
   round-trip the emitted config through its codec.

**`--no-debugging-server`** (optional) disables the OPP debugging server in the
emitted cluster: it drops `sysio::external_debugging_plugin` and
`--ext-debugging-server` from the operator daemons **and** skips starting the
server (persisted as `debuggingServerEnabled: false`). Use it when the target has
no reachable debugging server.

The result: `/path/to/external/` is a self-described, deployable cluster whose
`ClusterConfig.bind` carries your external addresses.

## Step 4 — Run / deploy the external cluster

On the target host (or in place), run it against the merged addresses:

```bash
wire-cluster-tool run --cluster-path /path/to/external
```

`run` resumes from the persisted state, dialing the addresses in
`ClusterConfig.bind`. The operator daemons' outpost-client endpoints
(`--outpost-ethereum-client` / `--outpost-solana-client`) are built at run time
from `config.bind.{anvil,solana}` — so they always match the merged bind.

## Step 5 (optional) — package per-node archives

```bash
wire-cluster-tool --cluster-path /path/to/external package --package-type zip
```

Writes one `<node>.zip` per node under `<external>/packages/` (each a full,
already-synced node config + `genesis.json`; `cluster-keys.json` is never
archived). This is the hand-off artifact for a multihost environment with distinct
compute + storage — S3/EC2, GCS, or any other; loosely coupled, provider-agnostic.
`--package-type` is a case-insensitive choice (`zip` today). **Archive production
only** — no storage upload, no compute provisioning.

## Verifying an external cluster in Docker

`scripts/external/verify-external-bind-config.mjs` stands the **whole** external
cluster up in a `docker compose` stack (depot + containerized anvil + solana) on a
private static-IP network and confirms the depot **advances the epoch** (or head
blocks under `--exclude-outposts`) against the containerized outposts.

```bash
node scripts/external/verify-external-bind-config.mjs \
  --build-path   <wire-sysio>/build/debug \
  --cluster-path /path/to/external
```

**How it works:**

- Reads the static IPs from `<cluster-path>/cluster-config.json` `.bind` (the
  merged `BindConfig`) — the *same* addresses the depot dials. There is no
  separate bind-file argument.
- Derives a `/24` subnet from those IPs, defines a docker network with an explicit
  IPAM subnet, and assigns each service its static `ipv4_address`. solana binds its
  own real IP (Agave's gossip panics on `0.0.0.0`).
- Builds one image (`scripts/external/external-outposts.Dockerfile`) carrying both
  `anvil` and `solana-test-validator`, **pinned to your host's versions** (detected
  at runtime → build args); the config folder is the *only* volume mount for the
  anvil/solana services.
- Loads the cloned outpost state so OPP can circulate: anvil `--load-state` of the
  cloned dump (the ETH outpost), and a solana ledger resume (the SOL outpost — the
  extracted `snapshots/` dir is dropped so the validator re-extracts from the
  self-contained archive at the new path).
- Runs with `security_opt: seccomp=unconfined` — Agave's snapshot loader uses
  `io_uring`, which docker's default seccomp profile blocks (`EPERM`).

**Flags:**

- `--exclude-outposts` — bring the chains up **fresh** (no cloned outpost state)
  and gate on depot **head-block** advance instead of the epoch.
- `--head-advance-blocks <n>` (head-block threshold), `--startup-timeout-seconds
  <n>`, `--image-tag <t>`, `--keep-up` (leave the stack running for inspection).

## Reference — `external-cluster-config.json`

The emitted, self-described payload:

- `bindings` — the merged `BindConfig`.
- `accounts.operators[]` — each operator account + its `keyProviders` (one per
  key type: wire/ethereum/solana, plus BLS with its proof-of-possession). KEY
  providers carry the material inline (testnet keys); SSM providers carry
  `awsSecretId` references (no plaintext).
- `wire.epochDurationSec` — the global epoch duration (compile-time budgets can't
  cross a remote boundary; this is the transport).
- `ethereum` / `solana` — the deployed-outpost references (address file, ABI
  files, chain id / IDL file) as in-tree, self-described paths.

## Known limitations & notes

- **Epoch-advance on resume.** A resumed cluster whose outposts already completed
  the current epoch (before the snapshot) may not tick the epoch — the outposts
  won't re-deliver, so the depot can't reach fresh consensus. The Docker verify's
  default epoch gate hits this; it is a resume-state consistency property, **not** a
  bind-config or Docker issue. `--exclude-outposts` (head-block gate) sidesteps it
  when you only need to prove the depot + bind config come up.
- **Toolchain version match is mandatory** for loading cloned state. The Docker
  image pins to the host's anvil/solana versions; a mismatch fails state loading
  (anvil crashes on `--load-state`; solana rejects the ledger).
- **`create-external-config` emits `KEY` providers inline for KEY-mode clusters** —
  testnet keys only. SSM-mode clusters emit `SSM` references (no plaintext).
- **`--no-debugging-server` is a stopgap.** With the debugging server integrated
  (it binds `config.bind.debuggingServer.address`), you can run *with* the server;
  disable it only when the target genuinely has no reachable debugging server.
