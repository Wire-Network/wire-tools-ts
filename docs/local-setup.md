# wire-cluster-tool: Local Setup (Non-Docker)

End-to-end instructions for building Wire's `wire-cluster-tool` CLI (alias `wtc`) and running the `flow-*`
suites from source on the host (Ubuntu 24.04 / WSL2), **without** a container image. Each repo's own
README / CLAUDE.md stays authoritative for its build; this page strings them together in dependency order.
The container route is described in `wire-devcontainer` (see §5).

**What `create` brings up:** one bios `nodeop`, the producer nodes, one `nodeop` per batch operator (3 by
default, each running the OPP relay daemon), optional API nodes, `kiod`, `anvil` with the Ethereum outpost
contracts deployed, and `solana-test-validator` with all four wire-solana programs loaded at genesis
(`liqsol_core`, which hosts the Solana OPP outpost, plus `liqsol_token`, `transfer_hook` and
`validator_leaderboard`).

---

## 1. Prerequisites

### 1.1 System packages (Ubuntu 24.04 / 25.x)

```bash
sudo apt-get update
sudo apt-get install -y \
    build-essential binutils ccache cmake ninja-build pkg-config \
    clang-18 libclang-18-dev llvm-18 libstdc++-14-dev \
    autoconf autoconf-archive automake libtool \
    curl git gnupg ca-certificates \
    doxygen fish golang \
    libbz2-dev libcurl4-openssl-dev libgmp-dev liblzma-dev \
    libncurses5-dev libusb-1.0-0-dev libzstd-dev zlib1g-dev \
    openjdk-21-jre-headless \
    python3 python3-pip python3-venv python3-dev \
    sudo tar unzip vim zip
```

`openjdk-21-jre-headless` runs the ANTLR parser generator of wire-sysio's query engine plugin at build time.

### 1.2 Toolchains (one-time)

Install only what's missing. The Solana / Anchor / Rust versions are pinned by `wire-solana`
(`Anchor.toml` → `anchor_version = "0.31.0"`, `solana_version = "4.2.0"`; `rust-toolchain.toml` → `1.86.0`) —
a mismatched validator or Anchor CLI produces program-load failures that look like flow bugs.

```bash
# -- Rust --
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
. "$HOME/.cargo/env"

# -- Foundry (anvil) --
curl -L https://foundry.paradigm.xyz | bash
$HOME/.foundry/bin/foundryup
export PATH="$HOME/.foundry/bin:$PATH"

# -- Solana CLI (Agave, solana-test-validator) --
sh -c "$(curl -sSfL https://release.anza.xyz/v4.2.0/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# -- Anchor via avm --
cargo install --git https://github.com/coral-xyz/anchor avm --force
avm install 0.31.0
avm use 0.31.0

# -- Node.js >= 24.9 --
# wire-tools-ts declares engines.node >=24.9. Below it, require(ESM) on yargs fails and
# every jest suite that reaches the @wireio/cluster-tool barrel dies at import.
# wire-sysio's OPP bundle generation also requires node >= 24.
nvm install 24 && nvm alias default 24

# -- pnpm (corepack) --
corepack enable
corepack prepare pnpm@10.32.1 --activate
pnpm setup      # creates the pnpm global bin dir; start a new shell afterwards (see §6.1)
```

Verify:

```bash
rustc --version; cargo --version
anvil --version
solana --version   # 4.2.0 ... Agave
anchor --version   # anchor-cli 0.31.0
node --version     # must be >= 24.9
pnpm --version     # 10.x
clang-18 --version
cmake --version
ninja --version
```

### 1.3 Repo layout

The repos must sit in the **same parent directory** — `wire-tools-ts/.pnpmfile.cjs` resolves `@wireio/*`
from its siblings (`../wire-libraries-ts/packages/*` and `../wire-sysio/build/opp/typescript`):

```
<parent>/
├── wire-cdt/
├── wire-sysio/          # build/<dir>/ holds the binaries; build/opp/ holds the generated OPP bundles
├── wire-libraries-ts/
├── wire-ethereum/
├── wire-solana/
├── wire-tools-ts/
└── wire-install/        # install prefix for wire-cdt (consumed by wire-sysio)
```

The platform checks these out together with Google's `repo` tool from `wire-platform-manifest`; cloning each
repo by hand (`git clone --recursive`) into one parent directory works too.

### 1.4 Branches

Use the branches the manifest declares (`wire-platform-manifest/default.xml`): the default revision
`master` for `wire-cdt`, `wire-sysio`, `wire-libraries-ts` and `wire-tools-ts`, and `next` for
`wire-ethereum` and `wire-solana`.

```bash
(cd wire-ethereum && git fetch && git checkout next)
(cd wire-solana   && git fetch && git checkout next)
```

---

## 2. Environment

```bash
export WIRE_ROOT="$HOME/ext"        # parent directory of all repos — adjust if different
export CC=/usr/bin/clang-18
export CXX=/usr/bin/clang++-18
# Strip any linuxbrew paths to prevent library conflicts
export PATH=$(echo "$PATH" | tr ':' '\n' | grep -v linuxbrew | tr '\n' ':' | sed 's/:$//')
# Keep a few cores free so 4GB-per-file compilation units don't OOM
export NUM_JOBS=$(( $(nproc) - 2 ))
```

---

## 3. Build steps

> Each step assumes `cd "$WIRE_ROOT/<repo>"` unless stated otherwise. Build order:
> wire-cdt → wire-sysio → wire-libraries-ts → wire-ethereum → wire-solana → wire-tools-ts.

### 3.1 `wire-cdt` — Contract Development Toolkit (WASM/ABI compilers)

Required by `wire-sysio` so `BUILD_SYSTEM_CONTRACTS=ON` can build the `.wasm` contracts. Installs into a
local prefix that `wire-sysio` is pointed at.

```bash
cd "$WIRE_ROOT/wire-cdt"
./vcpkg/bootstrap-vcpkg.sh       # one-time

cmake -S . -B build/release -G Ninja \
    -DCMAKE_BUILD_TYPE=Release \
    -DENABLE_CCACHE=ON \
    -DCMAKE_C_COMPILER="$CC" \
    -DCMAKE_CXX_COMPILER="$CXX" \
    -DCMAKE_TOOLCHAIN_FILE="$PWD/vcpkg/scripts/buildsystems/vcpkg.cmake" \
    -DCMAKE_INSTALL_PREFIX="$WIRE_ROOT/wire-install" \
    -DCMAKE_PREFIX_PATH="$WIRE_ROOT/wire-install"

cmake --build build/release -j"$NUM_JOBS"
cmake --install build/release
```

Rebuild wire-cdt whenever you update it — wire-sysio's system contracts compile against its headers, and a
stale CDT shows up as contract compile errors in wire-sysio.

### 3.2 `wire-sysio` — node software, system contracts and the OPP bundles

> **Constraint from `wire-sysio/CLAUDE.md`:** the build directory MUST be under `wire-sysio/build/<name>`
> (e.g. `build/debug`, `build/release`). Other locations break `configure_file` for test reference data.

```bash
cd "$WIRE_ROOT/wire-sysio"
git submodule update --init --recursive vcpkg libraries/appbase
./vcpkg/bootstrap-vcpkg.sh       # one-time

export BUILD_DIR="$PWD/build/debug"
cmake -S . -B "$BUILD_DIR" -G Ninja \
    -DCMAKE_BUILD_TYPE=Debug \
    -DBUILD_SYSTEM_CONTRACTS=ON \
    -DBUILD_TEST_CONTRACTS=ON \
    -DENABLE_CCACHE=ON \
    -DENABLE_TESTS=ON \
    -DCMAKE_C_COMPILER="$CC" \
    -DCMAKE_CXX_COMPILER="$CXX" \
    -DCMAKE_TOOLCHAIN_FILE="$PWD/vcpkg/scripts/buildsystems/vcpkg.cmake" \
    -DCMAKE_PREFIX_PATH="$WIRE_ROOT/wire-install"

cmake --build "$BUILD_DIR" -j"$NUM_JOBS"
# Some compilation units need ~4GB RAM; reduce -j if you see OOMs.
```

This produces `$BUILD_DIR/bin/{nodeop,kiod,clio,sys-util}` and the system-contract `.wasm`/`.abi`.

**OPP bundles.** `BUILD_OPP_BUNDLES` is `ON` by default: after the protobuf generation, a POST_BUILD step
runs `libraries/opp/tools/scripts/generate-opp-bundles.sh`, which builds the repo-local protoc plugins
(`protoc-gen-solidity`, `protoc-gen-solana`, `wire-protobuf-bundler` under `libraries/opp/tools/`) and writes
the TypeScript, Solidity and Solana model packages to `wire-sysio/build/opp/{typescript,solidity,solana}/`.
It requires `bash`, `npm`, `node >= 24` and `pnpm >= 10` at configure time; when any is missing CMake prints
`BUILD_OPP_BUNDLES is ON, but requirements are not met` and the bundles are not generated (see §6.2). Never
run `protoc` by hand — this build step is the only producer of those packages.

### 3.3 `wire-libraries-ts` — shared JS/TS packages

Produces `@wireio/shared`, `@wireio/shared-node`, `@wireio/sdk-core`, … which `wire-tools-ts` links from
source via its `.pnpmfile.cjs` (no `pnpm link` needed).

```bash
cd "$WIRE_ROOT/wire-libraries-ts"
pnpm install
pnpm build
```

### 3.4 `wire-ethereum` — Ethereum outpost contracts (Hardhat)

wire-ethereum uses **npm** (it ships a `package-lock.json`), so `.pnpmfile.cjs` auto-linking does not apply.
To build against the freshly generated Solidity models instead of the published
`@wireio/opp-solidity-models`, link the wire-sysio bundle first:

```bash
(cd "$WIRE_ROOT/wire-sysio/build/opp/solidity" && npm link)

cd "$WIRE_ROOT/wire-ethereum"
npm install
npm link @wireio/opp-solidity-models
npm run build          # npx hardhat compile
```

### 3.5 `wire-solana` — the four Anchor programs

The harness loads `liqsol_core`, `liqsol_token`, `transfer_hook` and `validator_leaderboard` onto
`solana-test-validator` at genesis and runs wire-solana's own `anchor run init-*` scripts during the
bootstrap. The Solana OPP outpost lives inside `liqsol_core` (`programs/liqsol-core/src/instructions/opp/`);
there is no separate outpost program.

```bash
cd "$WIRE_ROOT/wire-solana"
npm install
npm run build:programs   # the build the platform gate runs and the harness deploys
# Produces target/deploy/{liqsol_core,liqsol_token,transfer_hook,validator_leaderboard}.so (+ IDLs)
```

A bare `anchor build` is not equivalent to `build:programs`.

### 3.6 `wire-tools-ts` — harness monorepo + `wire-cluster-tool` CLI

```bash
cd "$WIRE_ROOT/wire-tools-ts"
pnpm install            # .pnpmfile.cjs links @wireio/* from ../wire-libraries-ts and ../wire-sysio/build/opp
pnpm build              # tsc -b across packages/cluster-tool, the flow-* packages and the debugging packages

# The CLI ships in packages/cluster-tool (bins `wire-cluster-tool` and `wtc`, both
# bin/wire-cluster-tool, which runs the built lib/cjs/cli/index.js). Put it on PATH:
export PATH="$WIRE_ROOT/wire-tools-ts/packages/cluster-tool/bin:$PATH"

command -v wire-cluster-tool
```

`pnpm install` prints a `Linked …` line per sibling package it resolved; if `@wireio/opp-typescript-models`
is not among them, `wire-sysio/build/opp/typescript` does not exist yet (see §3.2).

---

## 4. Running the cluster

```bash
# Kill any leftover chain processes from a previous run.
# Use exact names — an argv regex like "nodeop|anvil" can match the calling
# shell itself and SIGTERM your own session (exit 144).
killall nodeop kiod anvil solana-test-validator 2>/dev/null || true

export CHAIN_DIR="$HOME/ext/wire-chains/dev-001"

wire-cluster-tool create \
    --cluster-path="$CHAIN_DIR" \
    --force \
    --build-path="$WIRE_ROOT/wire-sysio/build/debug" \
    --ethereum-path="$WIRE_ROOT/wire-ethereum" \
    --solana-path="$WIRE_ROOT/wire-solana" \
    --producer-count=5 \
    --node-count=1 \
    --batch-operator-count=3 \
    --epoch-duration-sec=60

wire-cluster-tool run --cluster-path="$CHAIN_DIR"
# Ctrl+C to stop. To wipe: wire-cluster-tool destroy --cluster-path="$CHAIN_DIR"
```

> Note: the harness CLI looks for `nodeop`/`kiod`/`clio`/`sys-util` at
> `<build-path>/bin/<name>`. A full successful `cmake --build` populates
> that directory automatically via the `copy_bin` macro. If `build/bin/`
> is missing the binaries, the build didn't actually finish; check the
> ninja log for earlier failures.

The command comes first and every option follows it. Commonly used `create`
flags (the full reference, including the mock-data, API-node and external-outpost
options, is the `create` table in the repo root `README.md`):

| Flag | Notes |
|---|---|
| `--cluster-path` / `-d` | Directory for chain data, config, logs (required) |
| `--force` | Replace an existing cluster directory |
| `--build-path` | wire-sysio build directory (required) |
| `--ethereum-path` | wire-ethereum root; bootstraps anvil + the outpost contracts (required) |
| `--solana-path` | wire-solana root; bootstraps solana-test-validator with the wire-solana programs (required) |
| `--node-count` / `-n` | Producer node processes (default 1) |
| `--producer-count` / `-p` | Producer accounts to register (default 1) |
| `--batch-operator-count` / `-b` | Batch operators (default 3) |
| `--epoch-duration-sec` | Minimum epoch duration in seconds (default 60) |
| `--enable-mock-liq-pools` | Seed the mock LIQETH/LIQSOL yield pools during epoch zero |
| `--enable-mock-syndication-import` | Import the mock bonder's LIQ positions during epoch zero |

Swap-underwriter daemons have been removed: `--underwriter-count` still parses,
but any nonzero value is rejected.

### 4.1 Running a flow

Each `flow-*` package is a standalone scenario that bootstraps its own cluster. There are 13:

| Flow | Flow | Flow |
|---|---|---|
| `flow-batch-operator-slashing` | `flow-liq-syndication` | `flow-syndication-challenge` |
| `flow-batch-operator-termination` | `flow-liq-yield` | `flow-syndication-rate-limit` |
| `flow-emergency-stop` | `flow-node-owner-nft` | `flow-syndication-underwriting` |
| `flow-emissions-soak` | `flow-operator-collateral-deposit` | `flow-yield-distribution` |
| `flow-producer-registration` | | |

Launch one with `scripts/run-flow.mjs` and watch it with `scripts/flow-heartbeat-monitor.mjs` (one monitor
per run, pointed at the same cluster path):

```bash
cd "$WIRE_ROOT/wire-tools-ts"

./scripts/run-flow.mjs flow-operator-collateral-deposit \
    --cluster-path    /tmp/wire-flow \
    --wire-build-path "$WIRE_ROOT/wire-sysio/build/debug" \
    --ethereum-path   "$WIRE_ROOT/wire-ethereum" \
    --solana-path     "$WIRE_ROOT/wire-solana"

# In a second shell:
node scripts/flow-heartbeat-monitor.mjs --cluster-path /tmp/wire-flow
```

`run-flow.mjs` accepts the full name, the short form (`operator-collateral-deposit`) or a regex; with no
argument it opens an interactive picker. Each path option falls back to an env var — `WIRE_BUILD_PATH`,
`WIRE_ETH_PATH`, `WIRE_SOLANA_PATH`, `WIRE_CLUSTER_PATH` — and `--cluster-path` is optional (a fresh temp
cluster path is generated per run when omitted). It validates that the build path contains `bin/nodeop` and
the Ethereum path contains `hardhat.config.ts`. A flow exits `0` iff every Report step succeeded; the
Report lands under `<cluster>/reports/`. Give parallel runs disjoint `--cluster-path` directories.

---

## 5. Container route

`wire-devcontainer` builds the same toolchain into an image (`Dockerfile`, `e2e-build.Dockerfile`, driven by
`scripts/wire-local-setup.bash`); its `LOCAL_DOCKER_E2E_CLUSTER_GUIDE.md` and `LOCAL_SETUP_GUIDE.md` cover
that path. Where an image's pinned branches or build steps disagree with this page, the repos' own
README / CLAUDE.md files win.

---

## 6. Troubleshooting / gotchas

### 6.1 `pnpm add --global` / `pnpm link --global` errors with `ERR_PNPM_NO_GLOBAL_BIN_DIR`

`generate-opp-bundles.sh` registers its CLIs with `pnpm add --global`, which needs a global bin dir. Fresh
pnpm installs don't have one wired. Run `pnpm setup` once — it picks `$HOME/.local/share/pnpm`, writes
`PNPM_HOME` and the PATH export into your shell rc, and configures `global-bin-dir` / `global-dir`:

```bash
pnpm setup
# Then start a new shell (or `source ~/.zshrc` / `source ~/.bashrc`)
# so PNPM_HOME and PATH pick up.
```

### 6.2 `wire-sysio/build/opp/` is missing after a successful build

The OPP bundle step only attaches when CMake finds `bash`, `npm`, `pnpm` and `node` at configure time and
`node >= 24` / `pnpm >= 10`. Otherwise configure prints
`BUILD_OPP_BUNDLES is ON, but requirements are not met: … OPP bundles (TypeScript, Solidity, Solana) will NOT
be generated.` and the build succeeds without them. Fix the toolchain (§1.2), re-run the `cmake -S . -B
"$BUILD_DIR" …` configure so the check re-evaluates, and rebuild.

### 6.3 Cold-build error: `'sysio/opp/types/types.pb.hpp' file not found`

The `contracts_project` ExternalProject needs the zpp-generated `.pb.hpp` headers before it compiles; the
CMake wiring adds that dependency, so a single `cmake --build` produces the headers in order. If you still
see the error on a cold build, run the protos target explicitly first:

```bash
ninja -C build/debug opp_cdt_models.protos
cmake --build build/debug -j${NUM_JOBS}
```

### 6.4 `pkill -f "<regex>"` self-terminates your session

`pkill -f "solana-test-validator|anvil|kiod|nodeop"` matches the regex against the full argv (including the
pattern string itself), so `pkill` kills its parent shell — the Bash/zsh invocation exits 144 and
`wire-cluster-tool` never runs. Use `killall <exact name>` instead.

### 6.5 Workstation disk usage above 90%

`nodeop`'s resource monitor shuts a node down when its data volume passes the 90% threshold. Local clusters
set `resource-monitor-not-shutdown-on-threshold-exceeded = true`, but stale cluster directories still
consume space quickly — clear old `--cluster-path` directories before starting several clusters.
