# wire-tools-ts

TypeScript test harness and end-to-end flow suites for the WIRE **OPP** (Outpost
Protocol) cross-chain messaging system.

This repo stands up a full local cluster — the WIRE depot plus its Ethereum and
Solana outposts — and drives `flow-*` scenarios across all three chains, verifying
that OPP envelopes circulate and that on-chain state stays consistent end to end.

## What it exercises

The OPP message flow spans three chains:

- **WIRE depot** (`nodeop` + `kiod`) — system contracts `sysio.epoch`, `sysio.msgch`,
  `sysio.opreg`, `sysio.uwrit`, `sysio.reserv`, `sysio.chalg`, …
- **Ethereum outpost** (`anvil`) — `OPP.sol`, `OPPInbound.sol`, `OperatorRegistry.sol`,
  `ReserveManager.sol`, `StakingManager.sol` (+ `liqEth`).
- **Solana outpost** (`solana-test-validator`) — the `opp-outpost` Anchor program (+ `liqsol-*`).

## Where this repo fits in the platform

`wire-tools-ts` **consumes** the other WIRE repos as siblings on disk — it builds
nothing on-chain itself, it orchestrates the already-built artifacts of:

| Sibling repo | Provides | Built with |
|---|---|---|
| `wire-sysio` | `nodeop`, `kiod`, `clio`, system-contract `.wasm`/`.abi` | CMake / Ninja |
| `wire-ethereum` | outpost Solidity contracts + `deployLocal.ts` | Hardhat |
| `wire-solana` | `opp-outpost` program `.so` + IDL | Anchor |

All four are checked out together as a single workspace via Google's `repo` tool.
**For cloning and syncing the platform, follow
[`wire-platform-manifest/README.md`](https://github.com/Wire-Network/wire-platform-manifest/blob/master/README.md) first** —
this README assumes the siblings already exist next to this repo.

For a full, from-scratch host build of every dependency (Ubuntu 24.04 / WSL2),
see [`docs/local-setup.md`](docs/local-setup.md).

## Prerequisites

### Toolchain

| Tool | Pinned version | Why | Install |
|---|---|---|---|
| **Node.js** | `>= 22` | runs the harness + flow tests | [nodejs.org](https://nodejs.org/) or [nvm](https://github.com/nvm-sh/nvm) |
| **pnpm** | `10.32.1` | the only supported package manager | `corepack enable && corepack prepare pnpm@10.32.1 --activate` |
| **Rust** | `1.86.0` | toolchain for Solana / Anchor builds | see below |
| **Foundry (`anvil`)** | `>= 1.5` | local Ethereum node for the ETH outpost | see below |
| **Solana CLI (`solana-test-validator`)** | `2.1.21` (Agave) | local Solana validator for the SOL outpost | see below |
| **Anchor (`anchor`) via `avm`** | `0.31.0` | builds + loads the `opp-outpost` program | see below |

> The Solana / Anchor / Rust versions are pinned by `wire-solana`
> (`Anchor.toml` → `anchor_version = "0.31.0"`, `solana_version = "2.1.21"`;
> `rust-toolchain.toml` → `channel = "1.86.0"`). Match them — a mismatched
> validator or Anchor CLI produces program-load failures that look like flow bugs.

#### Install snippets

```bash
# ── Node + pnpm (via Corepack, ships with Node ≥ 16.9) ─────────────────────
corepack enable
corepack prepare pnpm@10.32.1 --activate

# ── Rust ───────────────────────────────────────────────────────────────────
# https://rustup.rs
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
. "$HOME/.cargo/env"

# ── Foundry / anvil ──────────────────────────────────────────────────────────
# https://book.getfoundry.sh/getting-started/installation
curl -L https://foundry.paradigm.xyz | bash
"$HOME/.foundry/bin/foundryup"
export PATH="$HOME/.foundry/bin:$PATH"

# ── Solana CLI (Agave) — pin 2.1.21 to match wire-solana ─────────────────────
# https://docs.anza.xyz/cli/install
sh -c "$(curl -sSfL https://release.anza.xyz/v2.1.21/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# ── Anchor via avm (Anchor Version Manager) — pin 0.31.0 ─────────────────────
# https://www.anchor-lang.com/docs/installation
cargo install --git https://github.com/coral-xyz/anchor avm --force
avm install 0.31.0
avm use 0.31.0
```

Verify:

```bash
node --version        # v22+  (v24 OK)
pnpm --version        # 10.32.1
anvil --version       # 1.5.x
solana --version      # 2.1.21 ... Agave
anchor --version      # anchor-cli 0.31.0
```

### Built dependency chains

The cluster loads compiled artifacts from the sibling repos. Build them before
running anything here (each repo's own README/CLAUDE.md is authoritative):

```bash
# 1. wire-sysio — produces bin/{nodeop,kiod,clio} + system-contract wasm/abi
#    (build/release or build/debug). See wire-sysio/CLAUDE.md for the CMake invocation.
ls ../wire-sysio/build/release/bin/nodeop      # sanity check

# 2. wire-ethereum — compile the outpost contracts
cd ../wire-ethereum && pnpm install && pnpm build      # npx hardhat compile

# 3. wire-solana — build the opp-outpost program (.so + IDL)
cd ../wire-solana && anchor build
```

## Install & build this repo

```bash
pnpm install      # also auto-links sibling @wireio/* packages via .pnpmfile.cjs
pnpm build        # tsc -b across all packages
```

## Packages

pnpm workspace (no nx/turbo/lerna); everything lives under `packages/`.

| Package | Name | Purpose |
|---|---|---|
| `cluster-tool` | `@wireio/cluster-tool` | Core harness: process managers, chain clients, bootstrap, **`wire-cluster-tool` CLI** |
| `flow-operator-collateral-deposit` | `@wireio/test-flow-operator-collateral-deposit` | Node-operator collateral deposit + withdraw remit |
| `flow-swap-with-underwriting` | `@wireio/test-flow-swap-with-underwriting` | Bidirectional SWAP (ETH ↔ SOL) with underwriting |
| `flow-swap-non-native-tokens` | `@wireio/test-flow-swap-non-native-tokens` | SWAP of non-native tokens (USDC / USDT / LIQ) |
| `flow-swap-variance-revert` | `@wireio/test-flow-swap-variance-revert` | Swap variance-tolerance revert |
| `flow-batch-operator-termination` | `@wireio/test-flow-batch-operator-termination` | Batch-operator termination via delivery underperformance |
| `flow-yield-distribution` | `@wireio/test-flow-yield-distribution` | `STAKING_REWARD` → `sysio.dclaim::onreward` → `fundclaim` |
| `flow-emissions-soak` | `@wireio/test-flow-emissions-soak` | Multi-hour emissions + `sysio.dclaim` payout soak |
| `debugging-*` / `test-app-server` | `@wireio/debugging-*` | OPP debugging server, client tooling, TUI, shared types |

Flow packages depend on the harness via `workspace:*`.

## Running flows

Every flow needs three paths into the sibling repos, supplied as env vars (or as
flags to the helper script below):

| Env var | Points to |
|---|---|
| `WIRE_BUILD_PATH` | `wire-sysio` build dir (must contain `bin/nodeop`), e.g. `../wire-sysio/build/release` |
| `WIRE_ETH_PATH` | `wire-ethereum` repo root (must contain `hardhat.config.ts`) |
| `WIRE_SOLANA_PATH` | `wire-solana` repo root (built `opp-outpost`) |
| `WIRE_CLUSTER_PATH` | *(optional)* cluster data dir; the harness generates a fresh temp dir per run when unset |

### Option A — the `run-flow.mjs` helper (THE canonical way)

[`scripts/run-flow.mjs`](scripts/run-flow.mjs) discovers the flow packages
dynamically, lets you pick one by name / regex (or interactively), validates the
sibling-repo paths, wires the env vars, and drives the matching package's `test`
script. **This is the canonical flow runner** — sessions/automation MUST use it
(per `wire-platform-manifest/.claude/rules/run-flows-via-canonical-scripts.md`),
and every live run is paired with the heartbeat monitor (see
[Monitoring a live flow run](#monitoring-a-live-flow-run) below).

```bash
# Usage: ./scripts/run-flow.mjs [name-or-pattern] [options]

# Interactive picker over every packages/flow-* (no argument):
./scripts/run-flow.mjs \
  --wire-build-path ../wire-sysio/build/release \
  --ethereum-path   ../wire-ethereum \
  --solana-path     ../wire-solana

# Exact name (full or short form):
./scripts/run-flow.mjs flow-swap-with-underwriting --wire-build-path … --ethereum-path … --solana-path …
./scripts/run-flow.mjs swap-with-underwriting       --wire-build-path … --ethereum-path … --solana-path …

# Regex — 1 match runs it, multiple matches drop into a scoped picker:
./scripts/run-flow.mjs swap --wire-build-path … --ethereum-path … --solana-path …
```

Each `--wire-build-path` / `--ethereum-path` / `--solana-path` flag falls back to
its env var (`WIRE_BUILD_PATH` / `WIRE_ETH_PATH` / `WIRE_SOLANA_PATH`); one of the
two is required. `--cluster-path` (env `WIRE_CLUSTER_PATH`) is optional — omit it
and the harness picks a fresh temp dir.

### Option B — `pnpm --filter` directly (what Option A runs under the hood)

For a human at an interactive terminal only — sessions/automation always go
through Option A, which adds path validation and correct stdio handling:

```bash
export WIRE_BUILD_PATH=../wire-sysio/build/release
export WIRE_ETH_PATH=../wire-ethereum
export WIRE_SOLANA_PATH=../wire-solana

pnpm --filter @wireio/test-flow-operator-collateral-deposit test
pnpm --filter @wireio/test-flow-swap-with-underwriting       test

# Every flow at once (long — builds first):
pnpm test
```

### Monitoring a live flow run

Every live run is watched by the canonical six-probe heartbeat monitor,
[`scripts/flow-heartbeat-monitor.mjs`](scripts/flow-heartbeat-monitor.mjs) —
**one instance per flow run**, started right after the flow and left running
for the run's entire life:

```bash
node scripts/flow-heartbeat-monitor.mjs --cluster-path <cluster-dir>
```

Every 90s it probes chain liveness, operators, epoch state, msgch envelopes,
`data/opp-debugging/` per-direction artifact counts, and the aggregate cluster
log (FATAL vs NOISE classified), printing one `HB …` line per cycle — and it
**bails loudly** on the fatal conditions (epoch stall, zero-delta opp-debugging,
plugin-layer failures) instead of letting a dead run burn its full `pollUntil`
deadline. It self-concludes when the flow exits. `--interval-seconds` /
`--epoch-duration-seconds` are the only tuning knobs; everything else derives
from the cluster's `cluster-config.json`.

Rules of the road (binding for sessions/automation; see
`wire-platform-manifest/.claude/rules/run-flows-via-canonical-scripts.md` and
`…/cluster-state-active-probing.md`):

- **Never** run a flow without its monitor, and never watch one with a
  hand-rolled `tail | grep` instead of the script.
- **Never** wrap either script in session-local launcher/watcher scripts — if a
  run needs a new probe, bail, or launch behavior, extend
  `flow-heartbeat-monitor.mjs` / `run-flow.mjs` themselves.
- Parallel runs need disjoint `--cluster-path` dirs; port allocation is
  collision-proof via `BindConfig`, so parallelism is bounded only by host
  resources.

## Launching a persistent test cluster

For interactive work — poking the chains with `clio` or the debugging TUI —
drive the `wire-cluster-tool` CLI directly (alias: `wtc`). Its commands:
`create`, `run`, `destroy`, `package`, and `create-external-config`.

```bash
wire-cluster-tool create \
  --cluster-path=/tmp/wire-cluster-tool-001 \
  --force \
  --build-path=/data/shared/code/wire-platform/wire-sysio/build/release \
  --producer-count=5 \
  --node-count=1 \
  --batch-operator-count=3 \
  --underwriter-count=1 \
  --epoch-duration-sec=60 \
  --ethereum-path=/data/shared/code/wire-platform/wire-ethereum \
  --solana-path=/data/shared/code/wire-platform/wire-solana \
&& wire-cluster-tool run --cluster-path=/tmp/wire-cluster-tool-001
```

`create` writes a `cluster-config.json` under `--cluster-path` and bootstraps the
chains; `run` starts the cluster from that saved config and **blocks until you
`Ctrl+C`** (which triggers a clean shutdown). Tear it down with:

```bash
wire-cluster-tool destroy --cluster-path=/tmp/wire-cluster-tool-001
```

### Common options (every command)

Options follow their command (`wire-cluster-tool <command> --flag …` — the
command comes first).

| Option | Alias | Description |
|---|---|---|
| `--cluster-path` | `-d` | **(required)** directory for cluster data + `cluster-config.json` |

`run` and `destroy` take only `--cluster-path`.

### `create` options

| Option | Alias | Default | Description |
|---|---|---|---|
| `--build-path` | | **(required)** | `wire-sysio` build dir (with `bin/nodeop`) |
| `--ethereum-path` | | **(required)** | `wire-ethereum` repo root; bootstraps `anvil` + outpost deploy |
| `--solana-path` | | **(required)** | `wire-solana` repo root; bootstraps `solana-test-validator` + `opp-outpost` |
| `--force` | | `false` | overwrite an existing cluster directory |
| `--node-count` | `-n` | `1` | producer node **processes** to launch |
| `--producer-count` | `-p` | `1` | producer **accounts** to register on-chain |
| `--batch-operator-count` | `-b` | `3` | batch operators |
| `--underwriter-count` | `-u` | `1` | underwriters |
| `--epoch-duration-sec` | | `60` | minimum epoch duration in seconds (the depot floor — `sysio.epoch::setconfig` rejects lower) |
| `--warmup-epochs` | | `1` | epochs before an operator goes `WARMUP` → `ACTIVE` |
| `--cooldown-epochs` | | `1` | epochs before an operator can deregister after `COOLDOWN` |
| `--terminate-max-consecutive-misses` | | — | consecutive missed-delivery termination threshold |
| `--terminate-max-percent-misses24h` | | — | 24h missed-delivery percentage termination threshold |
| `--terminate-window-ms` | | — | termination evaluation window in ms |
| `--bind-all` | | `false` | bind every daemon to `0.0.0.0` instead of loopback |
| `--enable-mock-reserves` | | `false` | seed the 8 mock (chain, token) PRIMARY reserves at bootstrap |
| `--bind-*` | | auto | per-daemon address/port pins (`--bind-anvil-port`, `--bind-nodeop-ports-bios-http`, …); unpinned ports are auto-assigned collision-free |
| `--bind-config` | | — | a `BindConfig` JSON file: a complete config is used verbatim (no port probing — remote addresses stay put), a partial one is merged over the resolved defaults (CLI `--bind-*` > file > defaults) |
| `--external-outpost-config` | | — | an `ExternalOutpostConfig` JSON file: bootstrap the depot against already-deployed REMOTE ETH+SOL outposts (skips the local anvil/validator + outpost deploys) |
| `--logging-levels-console` / `--logging-levels-file` | | `info` / `debug` | per-sink log levels |
| `--logging-file-format` | | `jsonl` | log file format: `text` or `jsonl` |
| `--report-path` / `--report-basename` | | `<cluster>/reports`, `cluster-build` | Report output location |

### Cluster signature providers

`create` controls how the cluster's own signing keys are handled via
`--signature-provider-type` (default `KEY`):

- `KEY` — keys are generated locally and embedded inline in each node's
  `--signature-provider` spec (`KEY:<privateKey>`). The default; byte-identical
  to the historical bootstrap.
- `SSM` — keys are published to AWS SSM Parameter Store and referenced as
  `SSM:<region>:<secretId>`. Requires `--signature-provider-ssm` carrying the
  region + secret-id pattern, either inline JSON (leading `{`) or a file path:

  ```bash
  wire-cluster-tool create … --signature-provider-type SSM \
    --signature-provider-ssm '{"awsRegion":"us-east-1","awsSecretIdPattern":"/wire-sysio/{cluster}/keys/{account}/{keyType}"}'
  ```

  Pattern placeholders: `{cluster}` (cluster dir basename), `{account}`,
  `{keyType}`; an unknown placeholder fails fast. Publishing runs at create
  time and needs AWS credentials.
- `KIOD` — material-less; the key lives in the local kiod wallet and specs
  render `KIOD:<kiod-url>`.

### Node packaging

`package` archives each node's full config tree (config.ini, logging.json, data
dirs) plus the cluster `genesis.json` into `<cluster>/packages/<node>.<ext>` —
one self-contained archive per node, the hand-off artifact for a multihost
environment with distinct compute and storage (for example S3/EC2 — equally GCS
or any other provider; deliberately loosely coupled to the target). Runs only on
a successfully-`create`d, STOPPED cluster:

```bash
wire-cluster-tool -d <cluster-dir> package --package-type zip   # case-insensitive
```

The format is a required `--package-type` choice (`zip` today; the
`ClusterPackageType` enum + its per-type backend is the extension seam). Under
the default `KEY` provider each node's `config.ini` embeds its signing-key
specs, so archives are sensitive; `cluster-keys.json` is NEVER included.

### External outpost clusters

Point a cluster at Ethereum + Solana outposts that already run on real chains
instead of the local anvil / solana-test-validator: pass
`--external-outpost-config <file>` at `create` (the depot bootstraps normally but
no local outpost is started or deployed), together with a `--bind-config` whose
`anvil` / `solana` addresses are the REMOTE RPC endpoints. The
`ExternalOutpostConfig` is fully self-described (RPC endpoints come from the bind
config; the Solana program id is parsed from the IDL):

```json
{
  "ethereum": {
    "addressFile": "/opt/wire/eth/outpost-addrs.json",
    "abiFiles": ["/opt/wire/eth/eth-abis/OPP.json", "/opt/wire/eth/eth-abis/OPPInbound.json"],
    "chainId": 11155111
  },
  "solana": { "idlFile": "/opt/wire/sol/liqsol_core.json" }
}
```

At `create` the harness verifies the external endpoints are reachable
(`eth_chainId` matches the configured `chainId`; Solana `getVersion` responds)
and gates bootstrap success on the depot's head block advancing — NOT on epoch
distribution (there is no local chain to advance). A remote `anvil`/`solana` bind
address WITHOUT `--external-outpost-config` fails fast.

### Exporting a deployable external config

`create-external-config` clones a CREATED, STOPPED local cluster into a fresh,
deployable directory with a different (typically remote) `BindConfig` merged in,
and emits a self-described `external-cluster-config.json`:

```bash
wire-cluster-tool create-external-config \
  --local-cluster-path    /opt/wire/testnet-local \
  --external-cluster-path /opt/wire/testnet \
  --external-bind-config  ~/testnet-bind-config.json
```

The five stages run as Report steps: **Validate** (the external `BindConfig` is
topology-compatible — one bind entry per node/role, every operator account
present, no duplicate ports, sane solana dynamic range; fails fast before any
write), **Clone** (copy the tree, excluding `*.pid` / `logs/` / `reports/`,
preserving `cluster-keys.json`'s 0600), **Rebind** (re-render `cluster-config.json`,
`genesis.json`, every node's `config.ini` / `logging.json`, and
`cluster-state.json` from the merged, external-rooted model — never text-patched),
**Emit** (`external-cluster-config.json`), and **Verify** (scan the tree for any
stale local port + round-trip the emitted JSON). The emitted config carries the
external `bindings`, each operator account's key providers **matching the source
cluster's provider type** (`KEY` inline for a `KEY` cluster, `SSM`
`awsSecretId` references — no plaintext — for an `SSM` cluster, material-less
`KIOD` for a `KIOD` cluster), the depot `epochDurationSec` + genesis path, and
the ethereum/solana outpost references — fully self-described, so the external
directory can then be `package`d and deployed on another host (`create` →
`create-external-config` → `package`).

#### End-to-end: an SSM-keyed cluster → deployable external config

A single cluster's lifecycle — `create` with keys in AWS SSM, then
`create-external-config` on that same cluster:

```bash
# 1. Create a cluster whose signing keys are PUBLISHED to AWS SSM (not inline).
#    Publishing runs at create time and needs AWS credentials in the environment.
wire-cluster-tool create \
  --cluster-path  /opt/wire/testnet-local \
  --build-path    /opt/wire-sysio/build/release \
  --ethereum-path /opt/wire-ethereum \
  --solana-path   /opt/wire-solana \
  --signature-provider-type SSM \
  --signature-provider-ssm '{"awsRegion":"us-east-1","awsSecretIdPattern":"/wire-sysio/{cluster}/keys/{account}/{keyType}"}'

# Each generated key is PutParameter'd to SSM under the rendered id — e.g.
#   /wire-sysio/testnet-local/keys/batchop.a/K1   ({cluster} = basename of --cluster-path)
# — and node/daemon --signature-provider specs render SSM:us-east-1:<id>.

# 2. Stop the cluster, then clone it into a deployable external directory with a
#    remote BindConfig merged in, emitting its self-described external config.
wire-cluster-tool create-external-config \
  --local-cluster-path    /opt/wire/testnet-local \
  --external-cluster-path /opt/wire/testnet \
  --external-bind-config  ~/testnet-bind-config.json

# Because the source cluster used SSM, external-cluster-config.json carries SSM
# providers ({awsRegion, awsSecretId} — the SAME ids create published,
# reconstructed from the pattern) with NO plaintext keys. (A KEY cluster emits
# inline KEY providers; a KIOD cluster, material-less KIOD providers.)
```

## Environment variables

| Variable | Used by | Description |
|---|---|---|
| `WIRE_BUILD_PATH` | flows | `wire-sysio` build dir (with `bin/nodeop`) |
| `WIRE_ETH_PATH` | flows | `wire-ethereum` repo root |
| `WIRE_SOLANA_PATH` | flows | `wire-solana` repo root |
| `WIRE_CLUSTER_PATH` | flows | cluster data dir (optional; temp dir if unset) |
| `LOG_LEVEL` | everything | harness log level: `debug` \| `info` \| `warn` \| `error` (default `info`) |

## Architecture

The harness manages chain child processes with `child_process.spawn` + `tree-kill`
(not pm2). On startup it `pkill`s any stray `nodeop` / `kiod` / `anvil` /
`solana-test-validator`, registers exit handlers for cleanup, and (when a cluster
dir is set) tees per-process and combined logs to `<cluster-path>/logs/`.

- **`processes/`** — `ProcessManager`, `WIREChainManager` (`nodeop`+`kiod`),
  `AnvilManager`, `SolanaValidatorManager`.
- **`cluster/`** — `ClusterManager` orchestrates the create → bootstrap → start lifecycle.
- **`clients/`** — `Clio`, `WIREClient`, `ETHClient` (ethers), `SOLClient` (`@solana/web3.js`).
- **`bootstrap/` + `cluster/ETHBootstrapper.ts` / `bootstrap/SOLBootstrap.ts`** —
  chain initialization and test-cluster custody seeding.

OPP debugging artifacts (the raw envelope bytes each side saw) land under
`<cluster-path>/data/opp-debugging/`.

## Code style & conventions

See [`CLAUDE.md`](CLAUDE.md) and `STYLE.md`. Highlights:

- Prettier: no semicolons, no trailing commas, double quotes, 2-space indent,
  arrow parens `avoid`.
- Every new/modified exported symbol ships unit tests in the same change.
- No `src/` in `import`/`export` specifiers — use package aliases or barrels.

## Appendix

### Useful Info

#### Parallel Process Caveats

Running two or more flows (or clusters) concurrently on one host is supported,
but only because each of the following shared-state hazards is explicitly
handled. Keep them in mind when touching any of these areas:

- **Port selection vs port binding.** `BindConfigProvider.resolve` picks free ports,
  but a picked port is not *bound* until its daemon spawns (possibly minutes
  later). A second process resolving in that window would happily re-pick it.
  Every resolving process therefore registers its full resolved `BindConfig`
  in `/tmp/wire-platform-bind-config/<pid>.bind-config.json` *before*
  releasing the host-global port lock; later resolvers read every LIVE
  registration into their exclusion set (dead-pid files are reaped —
  `kill(pid, 0)` + a `/proc/<pid>/cmdline` recycled-pid guard). Files are
  removed on process exit; `findAvailable` reads the registry but never
  writes it.
- **Hardhat deploy shares the repo's compile cache.** The Ethereum outpost
  deploy (`npx hardhat run src/scripts/deployLocal.ts`) compiles-if-stale
  into `<wire-ethereum>/artifacts/` + `<wire-ethereum>/cache/`, which are
  checkout-wide. Hardhat has no cross-process build lock, and two concurrent
  compiles corrupt those dirs for every later run. The harness serializes the
  hardhat invocation with a host-global file lock
  (`EthereumOutpostBootstrapper.HardhatDeployLockPath`, long-hold retry
  options). When artifacts are already fresh the hold is just the deploy
  (~30–60s); a colliding pair serializes its two deploys.
- **Ethereum deploy state is per-cluster, never repo-shared.** Deploy configs
  and address files (`outpost-addrs.json`, `liqeth-addrs.json`, …) live under
  `<cluster>/data/ethereum-deployments/`
  (`ClusterConfigProvider.ethereumDeploymentsPath`), and `deployLocal.ts` is pointed
  there via `WIRE_ETH_DEPLOYMENTS_PATH`. The pre-rewrite location —
  `<wire-ethereum>/.local/deployments/`, shared by every run — let one run's
  deploy wipe another's configs and address files mid-deploy (2026-07-02
  pair-1 incident: the "stale artifact" clear of run B deleted the address
  file run A was about to read). Never read outpost addresses from the repo
  path; go through `ClusterConfigProvider.ethereumDeploymentsPath` /
  `EthereumCollateralTool.loadOutpostAddresses(deploymentsPath)`.
- **Hardhat ABI artifacts are read-shared.** ABIs load from
  `<wire-ethereum>/artifacts/` (read-only after compile, which the deploy
  lock serializes) — that is fine to share; only *deploy state* had to move.
- **Solana state is already per-cluster.** The SOL bootstrap persists its
  keypair + mock-mints under `<cluster>/data/`, and programs load per
  validator via `--bpf-program` — no shared writes.
- **Process cleanup is pid-targeted, never name-targeted.** `ProcessManager`
  sweeps only pids recorded in THIS cluster's pidfiles and signals only its
  own registered pids on exit (with a `/proc` recycled-pid guard). A host-wide
  `pkill nodeop` from any tooling would kill *every* parallel run's nodes —
  see the incident note in `ProcessManager.ts`.
