# TypeScript Style Guide — wire-tools-ts

Project-specific conventions for the `wire-tools-ts` repo (test harness, flow tests, debugging tooling). Examples are drawn from real classes in this repo: `AnvilManager`, `KiodManager`, `ClusterManager`, `Clio`, etc.

> **Org-wide baseline**: the canonical style guide lives at `wire-libraries-ts/STYLE.md`. It covers general TypeScript idioms, tsconfig hierarchy, hybrid CJS+ESM packaging, and the React/Redux Toolkit stack. Rules in this file extend or specialize that baseline for the process-orchestration / CLI harness work in this repo. When the two conflict, the more specific guidance in this file wins for code under `wire-tools-ts/`.

---

## Pattern Matching with `ts-pattern`

Use [`ts-pattern`](https://github.com/gvergnaud/ts-pattern) for exhaustive, expression-oriented branching — especially when mapping a discriminated value to a result.

### Prefer `match()` over `switch` always

When a block of logic selects one of several paths and returns a value, use `match()` as an expression:

```ts
import { match } from "ts-pattern"

const config = await match(command)
  .with(Command.create, async () => {
    // resolve paths, build config, write to disk
    return config
  })
  .otherwise(() => {
    // load existing config from disk
    return JSON.parse(Fs.readFileSync(configFile, "utf-8"))
  })
```

**Key conventions:**

- **Expression position.** Assign the result of `match()` directly to a `const`. This makes it clear the match is producing a value, not performing side effects across scattered branches.
- **`.with()` for known variants.** Each `.with()` arm handles one known case (enum member, literal, or structural pattern). Keep each arm focused — if it grows beyond ~15 lines, extract a helper function.
- **`.otherwise()` as default.** Use `.otherwise()` for the fallback path. This replaces `default:` in a `switch` and guarantees every case is handled at the type level if using exhaustive matching (`.exhaustive()`).
- **Async arms.** `match(...).with(X, async () => ...)` returns a `Promise` — `await` the whole expression.

###  `match()` over `switch` always 

| Situation | Use |
|---|---|
| Branching produces a value | `match().with().otherwise()` |
| Exhaustive check on a union/enum | `match().with().exhaustive()` |
| Side-effect dispatch (start, stop, destroy) | `match().with().exhaustive()`          |
| Single boolean check | `asOption(),filter()`           |

---

## Functional Pipelines with `@3fv/prelude-ts`

Use [`@3fv/prelude-ts`](https://github.com/nicholasgasior/prelude-ts) for lightweight functional wrappers — primarily `Option` via `asOption()`. This is not about going full FP; it's about eliminating null-checks and making transformation pipelines explicit.

### `asOption()` for wrapping and transforming nullable values

The core pattern: wrap a value in `Option`, chain operations with `.map()` and `.tap()`, then unwrap with `.get()` or `.getOrElse()`.

**Promisifying callback APIs:**

```ts
import { Deferred } from "@wireio/shared"

function example(): Promise<void> {
  return Deferred.useCallback<void>(d =>
    randomNodeCallback(true, err => (err ? d.reject(err) : d.resolve()))
  ).promise
}
```

This pattern wraps a `Deferred.useCallback<T>`, It avoids a standalone `new Promise()` constructor and keeps the pipeline linear.

**Construct-validate-unwrap:**

Build an object, run assertions as a side-effect, then unwrap — all without intermediate variables:

```ts
const exePaths: ExePaths = asOption({
    nodeop: toBin("nodeop"),
    kiod: toBin("kiod"),
    clio: toBin("clio"),
    anvil: await which("anvil"),
  })
  .tap(paths =>
    Object.entries(paths).forEach(([name, path]) =>
      Assert.ok(path && Fs.existsSync(path), `${name} not found at ${path}`)
    )
  )
  .get()
```

---

## Options / Config / Defaults Pattern

A three-layer type system separates *what the caller can customize*, *what the runtime needs*, and *how defaults are resolved*.

### The three types

```ts
/** What the caller provides. All fields optional. */
export interface FooOptions {
  host?: string
  port?: number
  binary?: string
  extraArgs?: string[]
}

/** What the implementation requires. All fields required. */
export interface FooConfig extends Required<FooOptions> {}

/** Factory function that resolves defaults (may be async). */
export async function createFooDefaultOptions(): Promise<Partial<FooOptions>> {
  return {
    host: FooManager.DefaultHost,
    port: FooManager.DefaultPort,
    binary: asOption(await which("foo")).getOrUndefined()
  }
}
```

### Resolution via `lodash.defaults`

Merge caller options over defaults using `defaults()` from lodash. The caller's explicit values win; anything they omitted gets the default:

```ts
import { defaults } from "lodash"

async function create(options: FooOptions = {}) {
  const config = defaults(
    { ...options },          // spread to avoid mutating the input
    await createFooDefaultOptions()
  ) as FooConfig

  assert(await existsAsync(config.binary), "foo binary is required")
  return new FooManager(config)
}
```

### Conventions

| Concern | Type | Notes |
|---|---|---|
| Caller-facing API | `FooOptions` | All fields optional, documented with JSDoc |
| Internal runtime | `FooConfig` | `Required<FooOptions>` — no optionality inside the class |
| Default resolution | `createFooDefaultOptions()` | Returns `Partial<FooOptions>`, may be async (e.g., `which()` lookups) |
| Merge strategy | `lodash.defaults()` | Shallow merge, caller wins. Spread the input to avoid mutation |
| Validation | After merge | Assert required invariants (binary exists, port is valid, etc.) |

**Why `Required<T>` instead of a separate interface?** It mechanically guarantees the config shape mirrors the options shape. If you add a field to `FooOptions`, the config type updates automatically. No drift.

**Async defaults are fine.** Binary lookups (`which()`), filesystem checks, or environment reads often need async. Making `createFooDefaultOptions()` async keeps the factory honest about what it does.

### Namespace-scoped constants for defaults

Default values live as static constants in a companion `namespace` declaration (see Factory Model below), not as magic numbers in the defaults function:

```ts
export namespace FooManager {
  export const DefaultHost = "127.0.0.1"
  export const DefaultPort = 8545
  export const StartupTimeoutMs = 15_000
}
```

This makes defaults discoverable, overrideable by reference, and documents intent.

---

## Factory Model

Classes that manage external resources use an **async static factory** (`create()`) with a **private constructor**.

### Structure

```ts
export class FooManager {
  /** Async factory — resolves defaults, validates, returns ready instance. */
  static async create(options: FooOptions = {}): Promise<FooManager> {
    const config = defaults(
      { ...options },
      await createFooDefaultOptions()
    ) as FooConfig

    assert(await existsAsync(config.binary), "binary path is required")
    return new FooManager(config)
  }

  /** Private — force callers through create(). */
  private constructor(readonly config: FooConfig) {}

  get endpointUrl(): string {
    return `http://${this.config.host}:${this.config.port}`
  }

  async start(): Promise<void> {
    const { config } = this
    const args = [
      "--host", config.host,
      "--port", String(config.port),
    ]
    if (config.extraArgs) {
      args.push(...config.extraArgs)
    }

    await ProcessManager.get().spawn({
      label: "foo",
      command: config.binary,
      args
    })
    await waitForEndpoint(this.endpointUrl, {
      label: "foo",
      timeoutMs: FooManager.StartupTimeoutMs
    })
  }

  async stop(): Promise<void> {
    const handle = ProcessManager.get().get("foo")
    if (handle) await handle.kill()
  }
}

export namespace FooManager {
  export const DefaultHost = "127.0.0.1"
  export const DefaultPort = 8545
  export const StartupTimeoutMs = 15_000
}
```

### Why async factory + private constructor?

1. **Constructors can't be async.** Default resolution often involves filesystem or network checks. A static `create()` method can `await` these.
2. **Validation before instantiation.** The factory asserts invariants (binary exists, ports are free) *before* handing back an instance. Callers never hold an invalid manager.
3. **Single entry point.** The private constructor eliminates partially-configured instances. Every `FooManager` in existence was created through `create()` and passed validation.

### `start()` / `stop()` lifecycle

- `start()` builds a CLI args array incrementally, spawns via `ProcessManager.get().spawn()`, and waits for a health-check endpoint before returning.
- `stop()` looks up the process handle by label and kills it.
- Both are idempotent where feasible.
- CLI args are always `string[]` arrays, never shell-interpolated strings. Conditional args use `if (x) args.push(...)`.

### Singleton variant

For process-global resources (e.g., a process manager backed by a daemon), use a static `get()` accessor with a precondition:

```ts
export class ProcessManager {
  private static clusterPath: string
  private static instance: ProcessManager

  static setClusterPath(path: string): typeof ProcessManager {
    assert(
      !this.clusterPath || this.clusterPath === path,
      "Cluster path can only be set once"
    )
    this.clusterPath = path
    return this
  }

  static get(): ProcessManager {
    assert(!!this.clusterPath, "Cluster path must be set first")
    if (!this.instance) {
      this.instance = new ProcessManager()
    }
    return this.instance
  }

  private constructor() {}
}
```

**Key points:**

- `setClusterPath()` is an explicit initialization step, not a constructor parameter. This lets it happen at CLI parse time before any manager is instantiated.
- `get()` is idempotent after initialization. It asserts the precondition and lazily creates the singleton.
- Returning `typeof ProcessManager` from `setClusterPath()` enables chaining (`ProcessManager.setClusterPath(path).get()`), though typical usage calls them separately.
- Process managers never accept a `ProcessManager` instance as a constructor parameter — they always call `ProcessManager.get()` directly.

### Namespace as companion object

Use TypeScript's declaration merging to attach constants, helper functions, and sub-types to the class via a same-named `namespace`:

```ts
export class FooManager { /* ... */ }

export namespace FooManager {
  export const DefaultPort = 8545
  export const StartupTimeoutMs = 15_000
  export const NodePrefix = "node_"

  export function padIndex(i: number): string {
    return String(i).padStart(2, "0")
  }

  export function toNodePath(i: number): string {
    return `${NodePrefix}${padIndex(i)}`
  }

  export async function resolveExePaths(buildPath: string): Promise<ExePaths> {
    // resolve and validate all binary paths
  }
}
```

This keeps related constants and utilities co-located with their class without polluting the instance API. Consumers access them as `FooManager.DefaultPort` — no separate constants file needed.

---

## Naming Conventions

### Path variables

- **Directory** references use the suffix `Path`: `buildPath`, `clusterPath`, `walletPath`, `dataPath`.
- **File** references use the suffix `File`: `genesisFile`, `configFile`, `stateFile`, `defaultIniFile`.
- **Subpath constants** (relative segments within a parent directory, not absolute) use `Subpath`: `AnvilStateSubpath`, `SolanaLedgerSubpath`.

### Enums

String enums with `value = "value"` identity mapping. Serialization-friendly, readable in logs, and work as `ts-pattern` literal matchers without casting.

```ts
enum ClusterCommand {
  create = "create",
  run = "run",
  destroy = "destroy"
}
```

### Numeric literals

Use numeric separators for timeouts and large values. `15_000` reads as "15 seconds" at a glance; `999_999` is obviously "a large number."

---

## File & Directory Naming

### Directories — always `kebab-case`

Every directory in `src/` and `tests/` uses `kebab-case`. No camelCase, no PascalCase, no underscores. Multi-word directory names are hyphen-separated.

- **Correct**: `src/process-monitor/`, `src/log-tailing/`, `tests/features/process-monitor/`, `packages/debugging-client-tool-tui/`.
- **Wrong**: `src/processMonitor/`, `src/ProcessMonitor/`, `src/process_monitor/`.

This applies even when the directory mirrors a class or feature whose source file is PascalCase — the file is `ProcessMonitorService.ts`, the directory holding it is `process-monitor/`. Slice keys, Redux state shape, runtime identifiers, and other in-memory values are independent of directory casing — those follow their own rules (camelCase for slice keys, identity-mapped string enums for protocol identifiers).

### File names — case follows primary export

- **PascalCase** for files whose primary export is a class, interface, type alias, or class + companion namespace: `AnvilManager.ts`, `ClusterManager.ts`, `ProcessManager.ts`, `TestEnvironment.ts`, `ETHClient.ts`, `Clio.ts`, `NodeConfig.ts`, `JsonLogRecord.ts`.
- **camelCase** for files that export functions, constants, or utility collections with no primary class/type: `cli.ts`, `constants.ts`, `genesis.ts`, `keyGen.ts`, `loggingConfig.ts`, `startCmd.ts`, `logger.ts`, `util.ts`, `lineRender.tsx`.
- **`index.ts`** is the barrel re-export file. Always lowercase.
- The filename matches the primary export name exactly: `AnvilManager.ts` exports `class AnvilManager`; `keyGen.ts` exports `function generateNodeKeySet`; `JsonLogRecord.ts` exports `interface JsonLogRecord`.
- When a file has both a primary type AND helper functions, the type wins — file is PascalCase, functions live alongside the type with no rename pressure.

---

## Barrel Exports (`index.ts`)

Every subdirectory with one or more publicly-consumed files gets an `index.ts` barrel that re-exports those files. The barrel is the public face of the subdirectory — consumers import from the directory path, never from a specific `.ts` file inside it.

### Rules

- **One barrel per directory with public exports.** Empty / internal-only directories don't need one.
- **Barrel contents are `export * from "./<file>"` lines only.** No logic, no types, no constants.
- **Parent barrels re-export child subdirectories** via `export * from "./<subdir>/index.js"` — NOT `./<subdir>`. The resolver finds `index.ts` automatically.
- **Barrel paths INCLUDE extensions and DO reference `.js`/`.ts`.** `export * from "./rpc/index.js"`, not `"./rpc"`.
- **No wildcard re-exports of third-party surface.** Never `export * from "@wireio/opp-typescript-models"` or similar — consumers import generated-model types from their source package.

### Example

```
src/
├── index.ts                 # export * from "./rpc"; export * from "./cluster"
├── rpc/
│   ├── index.ts             # export * from "./Paths"
│   └── Paths.ts             # export namespace ApiPaths { ... }; export type Handler<...>
└── cluster/
    ├── index.ts             # export * from "./ClusterTypes"
    └── ClusterTypes.ts      # export interface ClusterConfig { ... }
```

Consumers write `import { ApiPaths, type Handler } from "@scope/package"` — they don't need to know whether `ApiPaths` lives under `rpc/` or `cluster/`. Reorganizing the internal layout stays transparent to consumers as long as the barrel keeps re-exporting the same names.

### Why

- **Refactor locality.** Moving `ApiPaths` from `src/api/` to `src/rpc/` should not break a single downstream import.
- **Single source of truth for the surface area.** Reviewing the root `index.ts` answers "what does this package expose" in one read.
- **Prevents deep-path coupling.** `import { X } from "@scope/package/internal/deep/file"` is an anti-pattern — it defeats the barrel and locks the layout.

### No `src/` traversal in `import` / `export` — EVER

**No `import` or `export` statement anywhere in this repo may contain `src/` in its specifier.** Applies to every file: production code, tests, tooling scripts, barrels, examples. No exceptions.

- **Correct**: `import { X } from "@scope/package"` or `"@scope/package/sub"` for cross-package, `"./Foo.js"` / `"../bar/index.js"` for in-package.
- **Wrong**: any specifier containing `/src/` (e.g. `"../src/X.js"`, `"../../src/services/Y.js"`, `"@scope/package/src/Z.js"`).

Every package exposes its surface through the `@scope/package` root alias (and subpath exports) resolved by the tsconfig `paths` map and by each jest's `moduleNameMapper`. Reaching into `src/` bypasses the barrel, couples the consumer to the physical layout, and breaks when folders are renamed. If an import path tempts you to include `src/`, the barrel or path map is wrong — fix it there.

### Unit tests required for every symbol

See CLAUDE.md "Unit tests are mandatory" — every created or modified function, class, interface, module, or constant ships with tests in the same commit. Coverage is not optional, even for one-line helpers.

---

## Variable Declarations

### Joined `const` declarations

Group related bindings into a single `const` statement with comma-separated declarators when they form a logical unit — particularly for destructuring alongside derived values:

```ts
const cfg = { ...this.config },
  { clusterPath, buildPath, dataPath, walletPath, exe } = cfg,
  launchTime = new Date().toISOString().replace("Z", "").slice(0, 23)
```

```ts
const argv = await parser.parse(),
  command = argv._[0] as ClusterCommand,
  clusterPath = Path.resolve(argv.clusterPath as string),
  configFile = Path.join(clusterPath, "cluster-config.json"),
  force = argv.force as boolean
```

Use joined declarations when:
- The bindings are derived from the same source (parsing argv, destructuring config).
- They share a lifecycle and will be used together.
- The group reads as "set up these related values."


### Module-level joined declarations

Top-level setup (e.g., CLI parser construction) uses the same pattern:

```ts
const scriptName = last(process.argv[1].split("/")),
  cleanArgs = process.argv.slice(2).filter(arg => !arg.startsWith("--inspect")),
  parser = Yargs(cleanArgs)
    .scriptName(scriptName)
    // ...
```

---

## `asOption` for Constructor/Init Tweaks

Beyond nullable unwrapping, use `asOption` to construct an object and apply initialization side-effects in a single expression. The pattern is: build the value, `.tap()` to mutate or validate, `.get()` to unwrap.

```ts
const exePaths: ClusterExePaths = asOption({
    nodeop: toBin("nodeop"),
    kiod: toBin("kiod"),
    clio: toBin("clio"),
    sysUtil: toBin("sys-util"),
    anvil: await which("anvil"),
    solanaTestValidator: await which("solana-test-validator")
  })
  .tap(paths =>
    Object.entries(paths).forEach(([name, path]) =>
      Assert.ok(
        path && Fs.existsSync(path),
        `${name} binary not found at ${path}`
      )
    )
  )
  .get()
```

This replaces the imperative equivalent:

```ts
// Avoid:
const exePaths = { nodeop: toBin("nodeop"), /* ... */ }
for (const [name, path] of Object.entries(exePaths)) {
  Assert.ok(path && Fs.existsSync(path), `${name} binary not found at ${path}`)
}
```

The `asOption` form keeps construction and validation as a single expression that can be assigned inline in a joined `const` declaration, a function return, or a parameter position.

Use this pattern for:
- Constructing an object and immediately validating all its fields.
- Building a value and logging or registering it as a side-effect.
- Any case where you want "construct then tweak" without a mutable intermediate.

---

## No Inline Literals

All meaningful string and number literals must be extracted into the companion `namespace` of the relevant class. No magic numbers or strings in method bodies.

> **Note:** For global constants, a `namespace` declaration is not required.
> **Note:** For `const` arrays which contain only literal values, that will not mutate, use `as const`.

### Constants in namespaces

```ts
export class AnvilManager { /* ... */ }

export namespace AnvilManager {
  export const DefaultHost = "127.0.0.1"
  export const DefaultPort = 8545
  export const DefaultChainId = 31337
  export const StartupTimeoutMs = 15_000
}
```

The default factory references these, never raw values:

```ts
export async function createAnvilDefaultOptions(): Promise<Partial<AnvilOptions>> {
  return {
    host: AnvilManager.DefaultHost,
    port: AnvilManager.DefaultPort,
    chainId: AnvilManager.DefaultChainId,
    binary: asOption(await which("anvil")).getOrUndefined()
  }
}
```

### Namespace scope rules

Every class that has associated constants, sub-types, or utility functions gets a companion namespace:

```ts
// Constants and defaults
export namespace KiodManager {
  export const DefaultPort = 8900
  export const DefaultUnlockTimeout = 999_999
  export const StartupTimeoutMs = 10_000
}

// Path builders and helpers
export namespace ClusterManager {
  export const BiosNodePath = "node_bios"
  export const ProducerNodePrefix = "node_"

  export function padIndex(i: number): string {
    return String(i).padStart(2, "0")
  }

  export function toProducerNodePath(i: number): string {
    return `${ProducerNodePrefix}${padIndex(i)}`
  }
}

// Sub-types (response shapes, config variants)
export namespace Clio {
  export interface IGetInfoResponse {
    server_version: string
    chain_id: string
    head_block_num: number
    // ...
  }
}
```

The namespace serves three roles depending on context:
1. **Default values and timeouts** — for process managers.
2. **Path constants and builders** — for orchestration classes.
3. **Sub-types and response interfaces** — for client classes.

If a literal appears in a method body and is not a trivially obvious value (like `0`, `""`, or `true`), extract it.

---

## Config Persistence

Resolved config objects (including executable paths, directory paths, and all settings) are serialized to JSON and written to disk during `create`. Subsequent commands (`run`, `destroy`) load the config from disk. This means:

- Expensive resolution (binary lookup via `which()`, directory creation) happens once.
- The persisted config is the single source of truth for all future invocations.
- The config interface must be JSON-serializable (no functions, classes, or circular references).
- Executable paths are resolved and validated in a dedicated `resolveExePaths()` function, called before the config is constructed, so the config object is always complete.

---

## Interface Design Summary

| Interface | Role | All fields optional? | Example |
|---|---|---|---|
| `FooOptions` | Caller input | Yes | `AnvilOptions`, `KiodOptions` |
| `FooConfig` | Runtime config | No (`Required<FooOptions>`) | `AnvilConfig`, `KiodConfig` |
| `ExePaths` | Resolved binary locations | No | All paths validated at resolution time |
| `ProcessConfig` | Cross-cutting spawn descriptor | Mix (some required, some optional) | `{ label, command, args, cwd?, env? }` |
| `ProcessHandle` | Returned resource handle | No | `{ pmId, pid, kill(), wait() }` |
| `FooState` | Serializable snapshot for persistence | No | Saved to JSON, loaded on relaunch |

---

## Framework-Native Dispatch

**Never write manual dispatch logic when the framework already provides routing.**

### Wrong: redundant match/switch on top of Yargs

```ts
// WRONG — Yargs already routes commands. This is redundant:
const config = match(command)
  .with(Command.create, () => { /* ... */ })
  .otherwise(() => { /* ... */ })

switch (command) {
  case "create": { await manager.create(); break }
  case "run": { /* ... */ break }
}
```

### Right: command handlers collocated with definitions

Pass the handler directly to `.command()`. The framework dispatches; you don't.

```ts
Yargs.command(
  ClusterCommand.create,             // enum member, not string literal
  "Create and bootstrap a new cluster",
  builder => builder
    .option("build-path", { /* ... */ }),
  async argv => {
    // all create logic lives here
    await createClusterManager(config).create()
  }
)
.command(
  ClusterCommand.run,
  "Start an existing cluster from saved state",
  identity,                           // no-op builder
  async _argv => {
    await createClusterManager(loadClusterConfig())
      .loadState()
      .startAndWait()
  }
)
```

### Key rules

- **Enum members as identifiers in all positions.** `ClusterCommand.create` as the command name, not `"create"`. This applies everywhere — function arguments, object keys, comparisons.
- **`identity` for no-op parameters.** When a framework callback requires a builder/transformer you don't need, pass `identity` from lodash rather than `() => {}` or omitting it.
- **Collocate definition and handler.** A command's options and its handler should be in the same `.command()` call, not split across parser definition and a separate dispatch block.

---

## Module-Level Concerns

### Shared state via middleware

Cross-cutting values (parsed from global args, derived paths) live in a module-level state object, populated by middleware before any command handler runs:

```ts
const GlobalArgs = {
  clusterPath: "",
  configFile: "",
  force: false
}

// In the parser chain:
.middleware(({ clusterPath, force }) => {
  const configFile = Path.join(clusterPath, "cluster-config.json")
  Object.assign(GlobalArgs, { clusterPath, configFile, force })
  ProcessManager.setClusterPath(clusterPath)
})
```

Command handlers destructure from `GlobalArgs` — no re-parsing, no passing args through function parameters.

### Signal handlers at module scope

Register `SIGINT`/`SIGTERM` handlers once at the top level, not inside a command handler:

```ts
const shutdown = async () => {
  log.info("shutting down...")
  await clusterManager?.stop()
}
process.on("SIGINT", () => void shutdown())
process.on("SIGTERM", () => void shutdown())
```

The handler references a module-level `clusterManager` variable that gets assigned when a command creates one. This avoids re-registering handlers per command and ensures cleanup runs regardless of which command is active.

---

## Extracted Helper Functions

Extract logically distinct operations into named module-level functions, even if called only once. This makes intent clear, enables reuse, and keeps command handlers focused:

```ts
function createClusterManager(config: ClusterConfig): ClusterManager {
  Assert.ok(!clusterManager, "Cluster manager already exists")
  Assert.ok(config, "Cluster config is required")
  clusterManager = new ClusterManager(config)
  return clusterManager
}

function loadClusterConfig(): ClusterConfig {
  const { configFile } = GlobalArgs
  Assert.ok(isNotEmpty(configFile), `Config file path is required: ${configFile}`)
  Assert.ok(Fs.existsSync(configFile), `config file not found: ${configFile}`)
  return JSON.parse(Fs.readFileSync(configFile, "utf-8"))
}
```

These helpers assert preconditions, log context, and return typed values. Command handlers become one-liners:

```ts
await createClusterManager(loadClusterConfig()).loadState().startAndWait()
```

---

## Fluent Method Chaining

Methods that configure or mutate an instance should return `this` to enable chaining:

```ts
class ClusterManager {
	loadState():this {
		// load state from disk...
		return this
	}
}

// Enables:
await createClusterManager(config).loadState().startAndWait()
```

Prefer chains over intermediate variables when the sequence reads as a pipeline of operations on the same object. Break the chain across lines for readability when it exceeds ~80 characters.

---

## General Conventions

- **`Assert.ook()` liberally.** Validate preconditions at the top of public methods and factory functions. Fail fast with a clear message rather than propagating `undefined` through the call stack.
- **JSDoc everywhere** EVERY FUNCTION, CLASS, TYPE, INTERFACE, VARIABLE, ENUM, CONSTANT, ... EVERYTHING.
- **Lodash for focused utilities.** Use `defaults`, `range`, `last`, `identity` — the small, composable functions. Don't import lodash for things TypeScript or `Array` methods handle natively.
- **`source-map-support/register`** at the CLI entry point. Stack traces should point to `.ts` lines, not compiled `.js`.
- **No string literals for known values.** If a value is defined in an enum, constant, or namespace, reference the identifier — never the raw string or number.
- **modern code** Use forEach, ... (spreads), map, filter, and reduce modern paradigms instead of for loops and other legacy style code
- **OPP & FP (functional programming)** is preferred over old-school if/else/switch and generally branching code.
    - Use `Future` from `@3fv/prelude-ts` for async flows.
    - Use `Option`/`asOption` from `@3fv/prelude-ts` for optional values and chained flows.
    - Use `Either` from `@3fv/prelude-ts` for error handling.
    - Use `match` from `ts-pattern` for pattern matching.
    