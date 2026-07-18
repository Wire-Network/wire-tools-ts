# @wireio/cluster-tool-shared

The shared **data contract** for WIRE test clusters — the plain-TypeScript
shapes that describe a cluster's persisted layout, consumed by both the
harness (`@wireio/cluster-tool`) and the debugging surface
(`@wireio/debugging-shared`, `debugging-server`, the TUI). Types only — no
runtime behavior lives here. Hydration/resolution of these shapes is owned by
`cluster-tool`'s provider namespaces (`ClusterConfigProvider`,
`BindConfigProvider`).

## Why this package exists

`cluster-tool` depends on `debugging-shared`, so `debugging-shared` cannot
import the harness's types without forming a cycle. Historically that forced
hand-maintained structural mirrors of the config shapes — a drift hazard. This
package sits *below* both: each shape is declared exactly once, and every
other expression of it (caller options, runtime providers) is derived from or
typed against these declarations.

## Contents

| Path | Contents |
|---|---|
| `src/cluster/ClusterFiles.ts` | `ClusterFiles` — the on-disk filenames (`cluster-config.json`, `cluster-state.json`, `cluster-keys.json`) |
| `src/cluster/ClusterState.ts` | `ClusterState` / `ClusterStateNode` / `ClusterStateNodePorts` / `ClusterStateNodeRole` — the secret-free post-bootstrap snapshot (`cluster-state.json`) |
| `src/config/BindConfig.ts` | `BindConfig` + the `BindConfig*` shape family, `BindOverrides<T>` (the derived caller-options projection), `Bind*Options`, `ClusterTopologyOptions` |
| `src/config/ClusterConfig.ts` | `ClusterConfig` (the `cluster-config.json` shape) + `ClusterConfig*` nested family, `CollateralRequirement`, `ClusterExecutablePaths` |
| `src/types/ChainTokenAmount.ts` | `ChainTokenAmount` — harness-local (chain, token) amount tuple |

## Design rules

- **Data only.** No I/O, no process state, no resolution logic — those live in
  `cluster-tool`'s providers. This package depends only on
  `@wireio/opp-typescript-models`.
- **Derivations over mirrors.** Caller-option shapes are derived from the
  resolved shapes via `BindOverrides<T>` (recursive all-optional projection
  with pin-whole atoms) — never hand-written in parallel.
- **Enum→literal assignability.** Fields that project identity string enums
  (`Report.Format`, `Level`, `LogFileAppender.Format`) are typed as literal
  unions; the enum values satisfy them structurally, so producers need no
  mapping code.
- **Secret hygiene.** `cluster-state.json` shapes here are secret-free by
  design; key material (`cluster-keys.json`) is `cluster-tool`-private and has
  no type here.

## Consuming

```jsonc
// package.json
"dependencies": { "@wireio/cluster-tool-shared": "workspace:*" }
```

```ts
import {
  ClusterConfig,
  ClusterFiles,
  ClusterState
} from "@wireio/cluster-tool-shared"
```

Add a project reference to `../cluster-tool-shared/tsconfig.json` in the
consumer's `tsconfig.cjs.json`; the root tsconfig `paths` map and each jest
`moduleNameMapper` already resolve the alias to source.

## Build & test

```bash
pnpm build   # tsc -b + hybrid ESM/CJS output fixup
pnpm test    # jest (tests/ mirrors src/)
```
