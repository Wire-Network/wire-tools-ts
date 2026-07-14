# Wire E2E Tests

End-to-end cluster harness and flow suites for the WIRE blockchain (OPP flows
across the WIRE depot and the Ethereum + Solana outposts).

**Binding companions to this file:**

- [`STYLE.md`](STYLE.md) — the repo's style guide. The "Orchestration Model",
  "Timing Budgets", "Ports & Parallel Runs", and "Naming Standards" sections
  are load-bearing for ALL new code; read them before designing anything.
- `wire-platform-manifest/.claude/rules/*.md` — authoritative cross-repo rules
  (injected by hook). Where this file summarizes one, the rule file wins.

## Package Manager

**pnpm** (`packageManager` field pins the version). Node `>=22` required.
Never use `npm` or `yarn`.

## Build & Test

```bash
pnpm install               # links workspace + sibling-repo packages
pnpm build                 # tsc -b project references (incremental)
pnpm test                  # build + jest across all 6 jest projects
pnpm --filter @wireio/cluster-tool test    # harness unit tests only
pnpm clean                 # remove lib/ + tsbuildinfo everywhere

# Run ONE flow — ALWAYS via the canonical runner (never invoke the flow
# executable or `pnpm --filter <pkg> test` directly in a session; see
# wire-platform-manifest/.claude/rules/run-flows-via-canonical-scripts.md):
node scripts/run-flow.mjs flow-operator-collateral-deposit \
  --cluster-path    /tmp/wire-flow \
  --wire-build-path <wire-sysio>/build/debug \
  --ethereum-path   <wire-ethereum> \
  --solana-path     <wire-solana>

# ...and EVERY live run is watched by the canonical heartbeat monitor,
# armed directly via a background Monitor (one instance per run):
node scripts/flow-heartbeat-monitor.mjs --cluster-path /tmp/wire-flow
```

A flow exits `0` iff every Report step succeeded. Under the hood the runner
resolves the flow name, validates the three sibling-repo paths, wires the
`WIRE_*` env vars, and drives the package's `test` script (which executes the
built `lib/index.js`). The e2e gate
(`wire-platform-build-system` → `run-flows.mjs`) discovers every `flow-*`
package dynamically and runs them through a work-stealing pool
(`FLOW_MAX_CONCURRENCY`); never special-case one flow's environment there —
and never hand-invoke that pool locally.

## Monorepo Structure

pnpm workspaces (no nx/turbo/lerna). All packages under `packages/`:

| Package | Purpose |
|---------|---------|
| `cluster-tool` (`@wireio/cluster-tool`) | THE core library: orchestration engine (PhaseGroup → Phase → Step → Report), process managers, chain clients, config/bind resolution, Steps palette, flow substrate (`FlowCLI`/`FlowScenario`), CLI |
| `flow-*` (13 packages) | One scenario each — standalone executables built on `FlowCLI.create(<Name>Scenario).run()`; batch-operator lifecycle (slashing/termination), collateral, reserves, emissions soak, node-owner NFT, yield distribution, and the six swap variants |
| `debugging-shared` / `debugging-server` / `debugging-client-shared` / `debugging-client-tool` / `debugging-client-tool-tui` | OPP debugging surface: shared types + storage paths, ingest server, RPC client, CLI, TUI |
| `test-app-server` | Fixture app server used by debugging tests |

Flow packages depend on `@wireio/cluster-tool` via `workspace:*`.

## TypeScript

- **Build**: `tsc -b` with project references (incremental, composite);
  source `src/` → output `lib/` (CommonJS, `"type": "commonjs"`,
  `module: nodenext`).
- **Import specifiers always carry `.js`** (nodenext resolution) — including
  barrel re-exports (`export * from "./Paths.js"`, `"./<subdir>/index.js"`).
- **Path mappings**: `@wireio/*` → `packages/*/src` in the base tsconfig;
  each jest config's `moduleNameMapper` does the equivalent, so the alias form
  works identically under tsc, jest, and runtime.
- `strictNullChecks` is OFF (`etc/tsconfig/tsconfig.base.json`) — never add
  `?? null` / `| null` ceremony; explicit `null` only where it carries runtime
  meaning (JSON persistence). See the manifest `prefer-null-over-undefined.md`.

## The Orchestration Model (read STYLE.md "Orchestration Model" first)

One declarative model is shared by the `wire-cluster-tool` CLI and every flow:

- `ClusterBuild` holds a tree of `ClusterBuildPhaseGroup` →
  `ClusterBuildPhase` → `ClusterBuildStep`; running it produces the
  **`Report`** (CSV/MD/HTML under `<cluster>/reports/`) — the per-step
  narrative that IS the deliverable. `ClusterBuildDefaults.create()` registers
  the ~40-phase bootstrap; a flow's `FlowScenario.build(cluster)` appends its
  scenario phases.
- **Every write/tx/spawn is its own Step** (factory `plan*`, named runner
  `run*`, typed `StepInput`, actor-first signature); reads run freely inside
  runners; assertions that ARE the scenario ride `verifyStep`. Cross-step data
  flows through `ctx.outputs` (`OutputKey<T>`) / `ctx.keyStore`
  (`ClusterKeyStore`) — never closures.
- Steps palette: `Steps.contracts.sysio.<contract>.<abi-action>` +
  `Steps.processes.<daemon>.planStart` + semantic composites
  (`Steps.keys`, `Steps.operator`, `Steps.registry`, …).

## Testing

- **`cluster-tool` + `debugging-*` keep jest** (`tests/` mirrors `src/`;
  ts-jest; `NODE_OPTIONS=--experimental-vm-modules` is wired into the test
  scripts for the ESM dynamic imports). Root `jest.config.ts` is
  multi-project.
- **`flow-*` packages have NO jest.** A flow is verified by RUNNING its built
  `lib/index.js` against a live cluster (its `test` script does exactly that) —
  launched via `scripts/run-flow.mjs` and watched via
  `scripts/flow-heartbeat-monitor.mjs`, never invoked directly (see "Live flow
  runs" below).
- **Unit tests are mandatory for every created or modified symbol** — happy
  path + at least one failure/edge case, in the same commit. Mirror the `src/`
  tree under `tests/`. No exceptions for "trivial" code.
- Tests must be environment-independent: never depend on incidental process
  ancestry (spawn a real child when a live pid with a known basename is
  needed), never bind fixed ports (`await BindConfig.findAvailable(...)` in
  `beforeAll`), never leak children or timers (tie helper-child lifetime to
  the worker, await the reap in `afterAll`).

### Live flow runs — the two canonical scripts, monitoring mandatory

Running a flow means exactly two scripts, per
`wire-platform-manifest/.claude/rules/run-flows-via-canonical-scripts.md`:

1. **Launch** with `scripts/run-flow.mjs <flow> --cluster-path … --wire-build-path …
   --ethereum-path … --solana-path …` (in a session: a tracked background shell
   with output redirected to a log — the log tail carries the
   `[flow-…] SUCCEEDED`/exit verdict).
2. **Watch** with `scripts/flow-heartbeat-monitor.mjs --cluster-path <cluster>`
   (90s cadence, all six probes) per
   `wire-platform-manifest/.claude/rules/cluster-state-active-probing.md` —
   armed DIRECTLY via a background Monitor, one instance per run; its stdout is
   the event stream and it self-concludes on flow exit or bail.

NEVER wrap either script in session-local launchers/watchers, never invoke
`lib/index.js` or `pnpm --filter <pkg> test` directly in a session, and extend
the scripts (not new ones) when a run needs something they lack. Epoch stall =
stop the run, preserve forensics, diagnose (`epoch-stall-is-fatal.md`).
Parallel runs get disjoint `--cluster-path` dirs; parallelism is bounded only
by host resources.

## No `src/` traversal in `import` / `export` — EVER

**No `import`/`export` specifier in this repo may contain `src/`.** Cross-package
imports use the package alias (`@wireio/cluster-tool`, `@wireio/shared`, …) or
a directory subpath (`@wireio/cluster-tool/cluster/processes`); in-package
imports are relative with `.js` extensions. The tsconfig `paths` map and each
jest `moduleNameMapper` resolve the alias to source. If an import tempts you
to include `src/`, the barrel or path map is broken — fix it there.

## Code Quality Invariants (scan every diff against these)

1. **Duplicated helpers** — extract at the right level: package-internal
   `src/utils/` topic file → shared across packages: `cluster-tool`'s
   `src/utils/` → usable outside this repo: promote into `@wireio/shared` /
   `@wireio/sdk-core` in `wire-libraries-ts`. Never copy-paste between flows
   or between the harness and a flow; subclass-common behavior goes on the
   base as `protected`.
2. **Magic literals** — every non-trivial value gets a named constant
   (companion namespace / `Constants.ts`); protocol identifiers get an enum.
3. **Enums over raw values** — always the member (`ProcessSignalName.SIGKILL`,
   `ChainKind.ETHEREUM`), never the string/number.
4. **Import hygiene** — order: Node built-ins → external → internal monorepo →
   relative, blank line between groups; no cross-package relative paths; no
   re-exporting third-party surface from local barrels.
5. **Filename shape** — PascalCase for class/type-primary files, camelCase
   topic files for utilities, `kebab-case` directories; component kind picks
   the folder + suffix (see STYLE.md "File & Directory Naming").
6. **Full JSDoc on exported symbols** — description, `@param`, `@return`;
   constants say what changing them affects.
7. **Process management is `child_process.spawn` + `tree-kill`** — never pm2
   or another orchestrator.
8. **Typed Redux hooks** in TUI code (`useAppDispatch`/`useAppSelector`) —
   the cross-process wallet extension in `wire-libraries-ts` is the sole
   raw-hooks exception.

## CLI Tool

`wire-cluster-tool` (bin from `cluster-tool`; alias `wtc`):

```bash
wire-cluster-tool create --cluster-path <dir> --build-path <wire-sysio-build> \
  --ethereum-path <wire-ethereum> --solana-path <wire-solana> [options]
wire-cluster-tool destroy -d <dir>     # stop + delete
```

`create` exposes every `ClusterBuildOptions` leaf as a `--kebab-path` flag via
the SAME `applyClusterBuildOptionsArgs` surface every flow uses (env vars
`WIRE_*` seed the path flags). Exit code mirrors the bootstrap Report.

## Key Architecture (`packages/cluster-tool/src/`)

- **`orchestration/`** — the engine (`ClusterBuild*`), `ClusterBuildContext`
  (clients + `outputs` + `keyStore` + typed events), `OutputStore`,
  `ClusterBuildDefaults` (bootstrap phases), `steps/` palette, per-chain
  outpost bootstrappers, `outputs/` (typed cross-step values incl.
  `OperatorAccount`, `ClusterKeyStore`).
- **`cluster/`** — slim `ClusterManager` (dirs/launch/destroy) +
  `processes/`: construction-safe `ManagedProcess` base (self-registers,
  graceful stop with cleared escalation timer) and
  `NodeopProcess`/`KiodProcess`/`AnvilProcess`/`SolanaValidatorProcess`
  (per-cluster disjoint `--dynamic-port-range` — REQUIRED for parallel runs).
- **`clients/`** — `WireClient` (typed contract client via
  `getSysioContract(name).actions/tables`, finality waits, `ClioRunner`),
  `EthereumClient`, `SolanaClient`, `KeyGenerator.create<T extends KeyType>`.
- **`config/`** — `ClusterBuildOptions` → `ClusterConfig.resolve` →
  persisted `cluster-config.json`; `BindConfig` (file-locked, cross-process
  port registry, `findAvailable`/`findAvailableRange`); `NodeConfig.plan` +
  renderers.
- **`report/`** — `Report` + CSV/MD/HTML renderers + `StepExtraRecorder`
  (ALS-scoped per-step extra capture — use native `mapSeries` on recorder
  paths, Bluebird detaches ALS).
- **`flow/`** — `FlowScenario`/`FlowCLI` + shared scenario contexts +
  `oppEnvelopeScan`.
- **`Constants.ts`** — dev keys, emission defaults, and **`ProtocolTiming`**
  (the timing envelope every protocol-wait budget derives from — see
  STYLE.md "Timing Budgets"; no concurrency-derived scaling exists).

## Local Package Linking

`.pnpmfile.cjs` hooks resolve `@wireio/*` packages from sibling repos
(`../wire-libraries-ts/packages/` → `sdk-core`/`shared`/`shared-node`;
`wire-sysio/build/opp/typescript` → `@wireio/opp-typescript-models`). They
link automatically on `pnpm install` when the siblings exist.

> **Never depend on `@wireio/opp-solidity-models` here** — it is
> `wire-ethereum`-only (`opp-models-packages.md`).

## Environment Variables

| Variable | Role |
|---|---|
| `WIRE_CLUSTER_PATH` | Cluster data dir (seeds `--cluster-path`; the e2e gate's ONLY per-flow value) |
| `WIRE_BUILD_PATH` | wire-sysio build dir (binaries + contract artifacts) |
| `WIRE_ETH_PATH` / `WIRE_SOLANA_PATH` | Outpost repo roots |
| `WIRE_FLOW_TIMEOUT_SCALE` | EXPLICIT operator override of flow timing (default 1, clamped [1,5]); no code derives it |
| `WIRE_ETH_DEPLOYMENTS_PATH` | Per-cluster hardhat deployments dir (parallel-run isolation) |
| `WIRE_BIND_REGISTRY_PATH` | Bind-registry dir override (tests sandbox it) |
| `WIRE_SOLANA_VALIDATOR_VERBOSE` | `"1"` drops `--quiet` so program logs land in the process log |
| `LOG_LEVEL` | Logging verbosity (default `info`) |

## How future sessions should design and produce code here

1. **Design from the rules, not from habit.** Before proposing a shape, check
   STYLE.md's orchestration/naming/options sections and the manifest rules.
   Design decisions are NEVER justified by "fewer files" or "simpler" —
   semantic, typed, explicit structure wins (`design-not-driven-by-file-count-or-simplicity.md`).
2. **Names come from the author's standard** (`standard-names-not-invented.md`):
   `assert*` never `require*`, `create*`/`new*`/`append`, `plan*`/`run*` for
   orchestration, full words (`ethereum`, `WireKeyGenerator`), no
   abbreviations. A user correction IS the standard — sweep it everywhere in
   the same change.
3. **Search generated types before declaring any type**
   (`@wireio/opp-typescript-models` + `SysioContracts`); typed table
   accessors over raw `getTableRows`; enums first-class at every call site
   (`ProcessSignalName`, `ChainKind`, …); no `unknown`/`any` shortcuts.
4. **Every write is a Step; tools return orchestration units** — never a bare
   side-effecting async function (`tools-return-orchestration-units.md`).
5. **Timing = envelope, ceilings = loaded-host worst case, polls return
   early.** Never reintroduce derived timeout scaling.
6. **Resource hygiene**: race timers cleared on settle, sockets/children
   closed and awaited, `.unref()` only for long-lived module timers — never to
   hide a leak.
7. **Ship tests with every symbol, run them, and report honestly** — a claim
   of "done" requires green output in hand; gaps are surfaced, not silent
   (`execute-the-entire-plan.md`).
8. **VCS discipline**: local edits are always fine; commits and every remote
   write happen ONLY on explicit instruction — one commit per named ask, and a
   review comment on a pushed PR authorizes a working-tree fix, never a new
   commit/push.

## Classes of mistakes to avoid (learned the hard way)

- **"The package.json is clean" is not proof a dep edge is absent** — check
  `node_modules/.pnpm/`, the lockfile, and `.pnpmfile.cjs` before declaring.
- **Before writing a new helper or type, grep** — `sleep`, `pollUntil`, retry,
  slug/enum bridges, and most domain types already exist.
- **Don't bulk re-export a generated-types package** — import at the call site.
- **Stale commented-out code is dead weight** — delete it.
- **A timer/handle that outlives its purpose is a bug even when invisible** —
  the jest "worker failed to exit gracefully" warning was a real 30s-per-stop
  production leak.
- **Concurrent validators need disjoint dynamic port ranges** — UDP
  double-binding is silent and eats forwarded transactions; never remove the
  `--dynamic-port-range` wiring.
