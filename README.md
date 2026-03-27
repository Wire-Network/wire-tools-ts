# wire-e2e-tests

End-to-end integration tests for the WIRE OPP (Outpost Protocol) cross-chain messaging system.

## Overview

Exercises the full OPP message flow across three blockchains:
- **WIRE** (nodeop + kiod) — Depot contracts (`sysio.epoch`, `sysio.msgch`, `sysio.uwrit`, `sysio.chalg`)
- **Ethereum** (anvil) — Outpost contracts (`OPP`, `OPPInbound`, `OperatorRegistry`, `OutpostReserve`)
- **Solana** (solana-test-validator) — Outpost program (`opp-solana-outpost`)

## Packages

| Package | Description |
|---------|-------------|
| `@wire-e2e-tests/harness` | Process management (nodeop, anvil, solana-test-validator) + chain clients |
| `@wire-e2e-tests/flow-a` | Flow A: Empty Epoch (balance sheet only) |
| `@wire-e2e-tests/flow-b` | Flow B: Node Operator Collateral Deposit |
| `@wire-e2e-tests/flow-c` | Flow C: SWAP 50 ETH → 1042 SOL (with underwriting) |

## Prerequisites

- `nodeop` + `kiod` built in `wire-sysio` (set `WIRE_BUILD_DIR`)
- `anvil` (Foundry) installed
- `solana-test-validator` (Agave) installed
- Node.js >= 22, pnpm

## Setup

```bash
pnpm install
pnpm link --global @wireio/sdk-core @wireio/opp-solidity-models
```

## Running Tests

```bash
# All flows
pnpm test

# Individual flows
pnpm test:flow-a    # Empty epoch
pnpm test:flow-b    # Collateral deposit
pnpm test:flow-c    # SWAP with underwriting

# With custom build dir
WIRE_BUILD_DIR=/path/to/build pnpm test:flow-a
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WIRE_BUILD_DIR` | `wire-sysio/build/claude` | Path to wire-sysio build directory |
| `WIRE_CHAIN_DIR` | `/tmp/wire-e2e-flow-*` | Chain data directory |
| `LOG_LEVEL` | `info` | Harness log level (`debug`, `info`, `warn`, `error`) |

## Architecture

The harness manages child processes with PID tracking, signal handling, and tree-kill cleanup (inspired by `wire-sysio/tools/cluster_manager.py`). Each flow test:

1. Starts required chain processes
2. Deploys contracts
3. Executes the OPP epoch cycle
4. Verifies attestation propagation and state consistency
5. Tears down all processes

## Code Style

- Prettier: no semicolons, no trailing commas, double quotes, 2-space indent, arrow parens `avoid`
- Formatting utility wrappers (e.g., `Deferred` + `asOption` pattern) preferred over raw `new Promise` for pm2 callback APIs
