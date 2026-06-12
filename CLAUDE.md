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
pnpm --filter @wireio/test-flow-operator-collateral-deposit test
pnpm --filter @wireio/test-flow-swap-with-underwriting test
pnpm --filter @wireio/test-flow-batch-operator-termination test
pnpm --filter @wireio/test-flow-swap-variance-revert test

# Run only harness unit tests
pnpm --filter @wireio/test-cluster-tool test

# Format code
pnpm format

# Clean all build artifacts
pnpm clean
```

## Monorepo Structure

pnpm workspaces (no nx/turbo/lerna). All packages under `packages/`:

| Package | Name | Purpose |
|---------|------|---------|
| `test-cluster-tool` | `@wireio/test-cluster-tool` | Core library: process managers, chain clients, bootstrap, CLI |
| `flow-operator-collateral-deposit` | `@wireio/test-flow-operator-collateral-deposit` | Flow: Node Operator Collateral Deposit |
| `flow-swap-with-underwriting` | `@wireio/test-flow-swap-with-underwriting` | Flow: Bidirectional SWAP (Ethereum ↔ Solana) with Underwriting |
| `flow-batch-operator-termination` | `@wireio/test-flow-batch-operator-termination` | Flow: Batch Operator Termination via Delivery Underperformance |
| `flow-swap-variance-revert` | `@wireio/test-flow-swap-variance-revert` | Flow: Swap Variance-Tolerance Revert |

Flow packages depend on `harness` via `workspace:*`.

## TypeScript

- **Build**: `tsc -b` with project references (incremental, composite)
- **Module system**: CommonJS output (`"type": "commonjs"` in all packages)
- **Base config**: `etc/tsconfig/tsconfig.base.cjs.json` (module=nodenext, target=esnext)
- **Source**: `src/` → **Output**: `lib/`
- **Import paths**: Always use `.js` extensions (nodenext module resolution)
- **Path mappings**: `@wireio/*` → `packages/*/src` (in base tsconfig)
- **Jest tsconfig**: `etc/tsconfig/tsconfig.base.jest.json` (disables composite/incremental)

## Testing

- **Framework**: Jest with `ts-jest`
- **Test location**: `packages/*/tests/*.test.ts`
- **Timeout**: 120s for flow tests (long-running chain operations)
- **Run mode**: `--runInBand` (no parallelization — tests manage shared processes)
- **Config**: Root `jest.config.ts` is multi-project, each package has its own `jest.config.ts`

### Unit tests are mandatory for every new or modified symbol

Every TypeScript function, class, type, interface, module, or exported constant that is **created or edited** in the course of a task MUST ship with unit tests in the same PR/commit.

- **Coverage**: every exported symbol has at least one behavior-verifying test — happy path plus one failure / edge case minimum. `beforeEach` state resets, mocks, and temp-dir fixtures are allowed.
- **Location**: mirror the `src/` tree under `tests/` — a test file for `src/services/ServiceManager.ts` lives at `tests/services/ServiceManager.test.ts`. Sub-utility files get their own tests; don't fold five utilities into one test file.
- **No exceptions for "trivial" code**: a one-line helper still warrants a one-line test. Trivial-looking code is where regressions hide.
- **Tests must run green locally** before declaring a task complete — `pnpm --filter <package> test` must pass with non-zero tests executed.
- This rule applies equally to production code and test tooling (fixtures, mocks).

### No `src/` traversal in `import` / `export` — **EVER**

**No `import` or `export` statement in this repo may contain `src/` anywhere in its specifier.** This applies to every file — production code, test files, tooling scripts, barrels, examples. Period.

Reaching into `src/` (via `./src/...`, `../src/...`, or `../../src/...`) couples the consumer to internal file layout and defeats the barrel-export + package-alias contract.

- **Correct (external / alias import)**: `import { ServiceManager } from "@wireio/debugging-client-tool-tui/services/ServiceManager.js"`
- **Correct (in-package relative)**: `import { ServiceManager } from "./ServiceManager.js"` (inside `src/services/`)
- **Wrong**: `import { ServiceManager } from "../../src/services/ServiceManager.js"`
- **Wrong**: `export * from "./src/services/index.js"`
- **Wrong**: `import { ServiceManager } from "@wireio/debugging-client-tool-tui/src/services/ServiceManager.js"`

The `moduleNameMapper` in every package's `jest.config.cjs` maps `@wireio/<pkg>/(.*)` → `<rootDir>/src/$1`; the `tsconfig.base.cjs.json` paths mapping does the equivalent for `tsc`. Both resolve the alias to the source file — the alias form works identically in tests and at runtime. If a module isn't reachable via its barrel yet, add the barrel entry first; never bypass the barrel by traversing `src/`.

If you find yourself tempted to write a `src/`-containing specifier to "just make it compile", stop — the barrel or the tsconfig path mapping is broken and needs fixing there, not worked around here.

## CLI Tool

`wire-test-cluster` (bin from harness package):

```bash
wire-test-cluster --chain-dir=<path> create --build-dir=<wire-sysio-build> [options]
wire-test-cluster --chain-dir=<path> run      # start cluster, Ctrl+C to stop
wire-test-cluster --chain-dir=<path> destroy   # stop + delete data
```

## Key Architecture

### Process Management (`harness/src/processes/`)
- **ProcessManager**: Core process lifecycle manager built on `child_process.spawn` + `tree-kill` (NOT pm2). On startup, kills existing `nodeop`/`kiod`/`anvil`/`solana-test-validator` via OS-level `pkill`. Registers exit handlers to clean up on tool exit. Supports per-process and combined cluster file logging when `clusterDir` is set.
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
- `../wire-opp/typescript/` → `@wireio/opp-typescript-models`

> **Do not depend on `@wireio/opp-solidity-models` here.** That package is `wire-ethereum`-only — see [`<wire-platform-root>/.claude/rules/opp-models-packages.md`](../.claude/rules/opp-models-packages.md). The TypeScript surface of both packages is identical; importing the Solidity-track package from a TS-only consumer couples the consumer to Solidity-track regen timing and produces silent stale-enum failures.

These link automatically on `pnpm install` if the sibling directories exist.

## Environment Variables

- `WIRE_BUILD_DIR`: Path to wire-sysio build directory (used by flow tests)
- `WIRE_CHAIN_DIR`: Override default chain data directory
- `LOG_LEVEL`: Logging verbosity (default: `info`)

## Documentation Comments

All generated or modified TypeScript code **must** include JSDoc comments (`/** ... */`), compatible with Docusaurus.

## Code Style

See `STYLE.md` for full patterns and examples.

- Prettier: no semicolons, no trailing commas, double quotes, 2-space indent, arrow parens `avoid`

### Critical rules

- **No string/number literals for known values.** If a value exists in an enum, constant, or namespace, use the identifier. `ClusterCommand.create`, not `"create"`. `AnvilManager.DefaultChainId`, not `31337`. `ClusterFiles.StateFilename`, not `".cluster_state.json"`.
- **No redundant dispatch.** If the framework routes commands (Yargs `.command()` handlers), do not add a `match()`/`switch` on top. Collocate handler logic with the command definition.
- **Modern JS iteration only.** `.forEach` / `.map` / `.filter` / `.reduce` / spread — never `for`, `for...of`, `for...in` for iteration. `while` is acceptable ONLY for deadline polling with an explicit timeout. For sequential async, use `Bluebird.each` / `Bluebird.mapSeries` / `Bluebird.reduce` (already in the harness tree).
- **FP branching**. Prefer `match` (from `ts-pattern`) for multi-branch value-producing dispatch or exhaustive enum checks. Single-guard `if` is fine — don't `match` two branches.
  - `Future` from `@3fv/prelude-ts` for async flows.
  - `Option`/`asOption` from `@3fv/prelude-ts` for optional values and chained flows.
  - `Either` from `@3fv/prelude-ts` for error handling.
  - `Deferred.useCallback` from `@wireio/shared` for promisifying callback APIs.
- **Enum over `as const` for string-literal maps.** `as const` is fine for complex / polymorphic value maps. For pure `{ Key: "key-string" }` tables, use an `enum` — it gives reverse mapping and survives rename refactoring.
- **Enum members as identifiers everywhere.** Command names, config keys, roles, chain kinds — always the enum member, never the raw string. Use enum reverse mapping (`SomeEnum[value]`) instead of hand-rolled lookup tables.
- **Fluent chains over intermediate variables.** Methods that configure state return `this`. Write `createClusterManager(config).loadState().startAndWait()`, not three separate statements.
- **Extract focused helpers.** Any logically distinct operation (load config, create manager, resolve paths) becomes a named module-level function with assertions at entry.
- **`identity` for no-op params.** When a framework callback is required but unneeded, pass `identity` from lodash.
- **Module-level shared state via middleware.** Cross-cutting values (global args, derived paths) go in a module-level object populated by Yargs `.middleware()`, destructured in handlers.
- **Typed Redux hooks.** Use `useAppDispatch` / `useAppSelector` (or equivalent typed wrappers exported from the slice's store file), never bare `useDispatch` / `useSelector`. Exception: cross-process extension packages (e.g. `wallet-browser-ext` in `wire-libraries-ts`) keep raw hooks by design — don't "fix" them.
- **Process management uses `child_process.spawn` + `tree-kill`.** Never reintroduce pm2 or other orchestration libraries without a concrete justification.

## Code Quality Invariants

The rules above are enforced on every change. Before declaring a task complete, scan the diff for:

1. **Duplicated helpers.** If the same function / guard / computation appears in two files, extract it:
   - **Package-internal:** a `src/util/` module exported for in-package use.
   - **Shared across packages in this repo:** `harness/src/util/` so all flows can import.
   - **Usable outside this repo:** promote into `@wireio/shared` / `@wireio/sdk-core` over in `wire-libraries-ts`, then depend on it from here. Never copy-paste between flows or between harness and a flow.
   - **Subclass-common behaviour:** `protected` method on the base class, not repeated in every subclass.

2. **Magic literals.** Every string or numeric value that isn't a trivial index / bound gets a named constant. Grouping options:
   - **File-local:** `const X = ...` at module top, or `as const` tuples / objects for literal-narrowed types.
   - **Cross-file within a package:** `export const` from a `constants.ts`.
   - **Protocol identifiers (command names, RPC method names, event names, endpoint paths):** an `enum` or `as const` object so IDE rename works.

3. **Enums over raw values.** Command names, statuses, chain kinds, attestation types — always the enum member. `ClusterCommand.create` not `"create"`; `ChainKind.ETHEREUM` not `2`. Rename propagates through the compiler; raw strings do not.

4. **Import hygiene.**
   - **No cross-package `../src/...` / `../../../lib/...` paths.** Cross-package imports use the package alias (`@wireio/test-cluster-tool`, `@wireio/shared`, etc.). In-package relative imports are fine.
   - **Do not re-export third-party surface from local barrels.** If a consumer needs a type from `@wireio/opp-typescript-models`, they import it from there directly — don't list 9 of its types in a `debugging-shared` barrel.
   - **Import order:** Node built-ins → external packages → internal monorepo packages → relative imports. Blank line between groups.

5. **Barrel-export discipline.**
   - Every subdirectory with public exports has an `index.ts` barrel of `export * from "./<file>.js"` lines only — no logic, types, or constants live in the barrel itself.
   - **Barrel file re-exports INCLUDE the `.js` extension.** `export * from "./Paths.js"`, never `"./Paths"`.
   - **Parent barrels re-export child subdirectories via `export * from "./<subdir>/index.js"`** — NOT `"./<subdir>"`. Always spell out `index.js`.
   - **All relative imports in `.ts` files include the `.js` extension.** `import { X } from "./foo.js"`, never `"./foo"`. Same applies to directory references — always `"./dir/index.js"`, never `"./dir"`.
   - Consumers import from the package root or from a directory path (`import { Foo } from "@scope/pkg"` or `"@scope/pkg/rpc"`) — never from a specific file. Moving `Foo.ts` between subdirectories should not ripple through callers.
   - Never `export *` a third-party package from a local barrel. See STYLE.md "Barrel Exports" for the full pattern.

6. **Filename shape.** Class- or type-primary files → PascalCase (`AnvilManager.ts`, `ClusterManager.ts`, `JsonLogRecord.ts`). Function/const/utility files → camelCase (`logger.ts`, `keyGen.ts`, `startCmd.ts`, `lineRender.tsx`). If the primary export changes shape (class → utility fns, or fns → type), rename the file to match. **Directories are always `kebab-case`** — `process-monitor/`, `log-tailing/`, never `processMonitor/` or `ProcessMonitor/`. See STYLE.md "File & Directory Naming" for the full rule.

7. **Full JSDoc on exported items.**
   - Functions / methods: description, `@param` for each arg, `@return` (unless `void`), `@example` when non-obvious.
   - Exported constants: description + **what changing the value affects** (one line is enough, but it has to answer "why would I touch this").
   - NodeJS typed literals like `"pipe"`, `"inherit"`, `"ignore"` in `StdioOptions` stay inline — they're typed, not magic.

## Cross-repo rules

- **OPP models packages have repo-specific consumers.** `@wireio/opp-typescript-models` is the canonical TS package for `wire-tools-ts` (and `wire-libraries-ts` where applicable). `@wireio/opp-solidity-models` is `wire-ethereum`-ONLY. Never depend on `opp-solidity-models` from a TS-only repo — see [`<wire-platform-root>/.claude/rules/opp-models-packages.md`](../.claude/rules/opp-models-packages.md). And neither package may appear in a `wire-libraries-ts` package.json — the generators that produce them live there.
- **Shared types consumed by both a server and its client live in the shared package** (`debugging-shared` for the debugging server/client/TUI; don't duplicate host/port/version strings across two `package.json`s).

## Classes of mistakes to avoid (learned the hard way)

- **"The package.json is clean" is not proof the dep edge is absent.** If `node_modules/.pnpm/<forbidden>/` exists, investigate the lockfile, the `.pnpmfile.cjs` hooks, and any transitive chain before declaring victory.
- **Before writing a new helper or type, grep.** `sleep`, `pollUntil`, cluster state filenames, default host/port — these already exist somewhere. Reusing beats re-inventing.
- **Don't bulk re-export a generated-types package.** Import what you need at the call site.
- **Stale commented-out code is dead weight.** If `match()` replaces an `if/else` chain, delete the commented original. Leaving "for reference" is how slop accumulates.

