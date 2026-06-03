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
[`wire-platform-manifest/README.md`](../wire-platform-manifest/README.md) first** —
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
| `test-cluster-tool` | `@wireio/test-cluster-tool` | Core harness: process managers, chain clients, bootstrap, **`wire-test-cluster` CLI** |
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

### Option A — the `run-flow.mjs` helper (recommended)

[`scripts/run-flow.mjs`](scripts/run-flow.mjs) discovers the flow packages
dynamically, lets you pick one by name / regex (or interactively), wires the env
vars, and runs jest in the matching package.

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

### Option B — `pnpm --filter` directly

```bash
export WIRE_BUILD_PATH=../wire-sysio/build/release
export WIRE_ETH_PATH=../wire-ethereum
export WIRE_SOLANA_PATH=../wire-solana

pnpm --filter @wireio/test-flow-operator-collateral-deposit test
pnpm --filter @wireio/test-flow-swap-with-underwriting       test

# Every flow at once (long — builds first):
pnpm test
```

## Launching a persistent test cluster

For interactive work — poking the chains with `clio`, the debugging TUI, or
attaching multiple flow runs to one long-lived cluster — drive the
`wire-test-cluster` CLI directly (alias: `wtc`). It has three commands: `create`,
`run`, `destroy`.

```bash
wire-test-cluster \
  --cluster-path=/tmp/wire-test-cluster-001 \
  --force \
  create \
    --build-path=/data/shared/code/wire-platform/wire-sysio/build/release \
    --prod-count=5 \
    --pnodes=1 \
    --batch-operators=3 \
    --underwriters=1 \
    --epoch-duration=60 \
    --ethereum-path=/data/shared/code/wire-platform/wire-ethereum \
    --solana-path=/data/shared/code/wire-platform/wire-solana \
  && wire-test-cluster \
  --cluster-path=/tmp/wire-test-cluster-001 run
```

`create` writes a `cluster-config.json` under `--cluster-path` and bootstraps the
chains; `run` starts the cluster from that saved config and **blocks until you
`Ctrl+C`** (which triggers a clean shutdown). Tear it down with:

```bash
wire-test-cluster --cluster-path=/tmp/wire-test-cluster-001 destroy
```

### Global options

| Option | Alias | Description |
|---|---|---|
| `--cluster-path` | `-d` | **(required)** directory for cluster data + `cluster-config.json` |
| `--force` | | remove an existing `--cluster-path` before `create` |

### `create` options

| Option | Alias | Default | Description |
|---|---|---|---|
| `--build-path` | | **(required)** | `wire-sysio` build dir (with `bin/nodeop`) |
| `--ethereum-path` | | — | `wire-ethereum` repo root; bootstraps `anvil` + outpost deploy |
| `--solana-path` | | — | `wire-solana` repo root; bootstraps `solana-test-validator` + `opp-outpost` |
| `--pnodes` | `-p` | `1` | producer **nodes** to launch |
| `--nodes` | `-n` | `0` | non-producer nodes to launch |
| `--prod-count` | | `21` | producers to **register** on-chain |
| `--batch-operators` | `-b`, `--batch-operator-count` | `3` | batch-operator nodes (3–21) |
| `--underwriters` | `-u`, `--underwriter-count` | `1` | underwriter nodes (1–100) |
| `--epoch-duration` | `--epoch-duration-sec` | `360` | epoch duration in seconds (depot floor is **60** — `sysio.epoch::setconfig` rejects lower) |
| `--topology` | `-s` | `mesh` | network topology: `mesh` \| `ring` \| `star` |
| `--http-secure` | | `false` | use HTTPS for RPC endpoints |
| `--warmup-epochs` | | `1` | epochs before an operator goes `WARMUP` → `ACTIVE` |
| `--cooldown-epochs` | | `1` | epochs before an operator can deregister after `COOLDOWN` |
| `--underwriter-collateral-json-file` | | — | per-underwriter collateral overrides (`ChainTokenAmount[]` or `ChainTokenAmount[][]`); defaults to 1000 base units of WIRE/ETH/SOL each |

> `--ethereum-path` / `--solana-path` are declared optional but a full OPP cluster
> needs **both** outposts — supply them unless you are deliberately bringing up a
> depot-only chain.

### Attaching flows to a running cluster

Flow tests default to **fresh** mode (they create and tear down their own cluster).
To instead point a flow at the persistent cluster above, set `WIRE_CLUSTER_CONFIG`
to its config file — the flow runs in **attach** mode against the live processes:

```bash
WIRE_CLUSTER_CONFIG=/tmp/wire-test-cluster-001/cluster-config.json \
  pnpm --filter @wireio/test-flow-swap-with-underwriting test
```

## Environment variables

| Variable | Used by | Description |
|---|---|---|
| `WIRE_BUILD_PATH` | fresh-mode flows | `wire-sysio` build dir (with `bin/nodeop`) |
| `WIRE_ETH_PATH` | fresh-mode flows | `wire-ethereum` repo root |
| `WIRE_SOLANA_PATH` | fresh-mode flows | `wire-solana` repo root |
| `WIRE_CLUSTER_PATH` | fresh-mode flows | cluster data dir (optional; temp dir if unset) |
| `WIRE_CLUSTER_CONFIG` | attach-mode flows | path to an existing `cluster-config.json` |
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
