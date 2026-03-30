# Wire E2E Tests

End-to-end test harness and test suites for the WIRE blockchain (OPP flows across WIRE, ETH, and SOL chains).

## Package Manager

**pnpm** (`pnpm@10.32.1`, specified in `packageManager` field). Node `>=22` required.

Never use `npm` or `yarn`.

## Build & Test

```bash
# Install dependencies
pnpm install

# Build all packages (uses TypeScript project references)
pnpm build

# Build in watch mode
pnpm build:dev

# Run all tests (builds first)
pnpm test

# Run a specific flow's tests
pnpm test:flow-a
pnpm test:flow-b
pnpm test:flow-c

# Run only harness unit tests
pnpm --filter @wire-e2e-tests/harness test

# Format code
pnpm format

# Clean all build artifacts
pnpm clean
```

## Monorepo Structure

pnpm workspaces (no nx/turbo/lerna). All packages under `packages/`:

| Package | Name | Purpose |
|---------|------|---------|
| `harness` | `@wire-e2e-tests/harness` | Core library: process managers, chain clients, bootstrap, CLI |
| `flow-a` | `@wire-e2e-tests/flow-a` | Test: Empty Epoch (balance sheet only) |
| `flow-b` | `@wire-e2e-tests/flow-b` | Test: Node Operator Collateral Deposit |
| `flow-c` | `@wire-e2e-tests/flow-c` | Test: SWAP 50 ETH → 1042 SOL (with underwriting) |

Flow packages depend on `harness` via `workspace:*`.

## TypeScript

- **Build**: `tsc -b` with project references (incremental, composite)
- **Module system**: CommonJS output (`"type": "commonjs"` in all packages)
- **Base config**: `etc/tsconfig/tsconfig.base.cjs.json` (module=nodenext, target=esnext)
- **Source**: `src/` → **Output**: `lib/`
- **Import paths**: Always use `.js` extensions (nodenext module resolution)
- **Path mappings**: `@wire-e2e-tests/*` → `packages/*/src` (in base tsconfig)
- **Jest tsconfig**: `etc/tsconfig/tsconfig.base.jest.json` (disables composite/incremental)

## Testing

- **Framework**: Jest with `ts-jest`
- **Test location**: `packages/*/tests/*.test.ts`
- **Timeout**: 120s for flow tests (long-running chain operations)
- **Run mode**: `--runInBand` (no parallelization — tests manage shared processes)
- **Config**: Root `jest.config.ts` is multi-project, each package has its own `jest.config.ts`

## CLI Tool

`wire-test-cluster` (bin from harness package):

```bash
wire-test-cluster --chain-dir=<path> create --build-dir=<wire-sysio-build> [options]
wire-test-cluster --chain-dir=<path> run      # start cluster, Ctrl+C to stop
wire-test-cluster --chain-dir=<path> destroy   # stop + delete data
```

## Key Architecture

### Process Management (`harness/src/processes/`)
- **ProcessManager**: Core pm2-backed process lifecycle manager. On startup, kills existing `nodeop`/`kiod`/`anvil`/`solana-test-validator` via OS-level `pkill`. Registers exit handlers to clean up on tool exit. Supports per-process and combined cluster file logging when `clusterDir` is set.
- **WIREChainManager**: Manages `nodeop` + `kiod` processes
- **AnvilManager**: Manages local Ethereum node (`anvil`)
- **SolanaValidatorManager**: Manages `solana-test-validator`

### Cluster Management (`harness/src/cluster/`)
- **ClusterManager**: Orchestrates full WIRE cluster lifecycle — creates directory structure, generates genesis + config, runs bootstrap sequence, manages node state persistence
- Cluster data lives under `<chainDir>/data/node_<id>/` with per-node config, blocks, and logs

### Clients (`harness/src/clients/`)
- **Clio**: WIRE CLI wrapper (wallet, contract deployment, account management)
- **WIREClient**: HTTP client for WIRE chain RPC
- **ETHClient**: Ethereum client (ethers.js)
- **SOLClient**: Solana client (@solana/web3.js)

### Bootstrap (`harness/src/bootstrap/`)
- **WIREBootstrap**: Chain initialization (system contracts, accounts, producers)
- **ETHBootstrap**: Anvil setup + OPP contract deployment
- **SOLBootstrap**: Solana validator + Anchor program deployment

## Local Package Linking

`.pnpmfile.cjs` hooks resolve `@wireio/*` packages from sibling repos:
- `../wire-libraries-ts/packages/` → `@wireio/sdk-core`, `@wireio/shared`, `@wireio/shared-node`
- `../wire-opp/solidity/` → `@wireio/opp-solidity-models`

These link automatically on `pnpm install` if the sibling directories exist.

## Environment Variables

- `WIRE_BUILD_DIR`: Path to wire-sysio build directory (used by flow tests)
- `WIRE_CHAIN_DIR`: Override default chain data directory
- `LOG_LEVEL`: Logging verbosity (default: `info`)

## Code Style

- Prettier: no semicolons, no trailing commas, double quotes, 2-space indent, arrow parens `avoid`
- Formatting utility wrappers (e.g., `Deferred` + `asOption` pattern) preferred over raw `new Promise` for pm2 callback APIs
