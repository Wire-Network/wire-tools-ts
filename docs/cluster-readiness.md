# Connected cluster readiness

`wire-cluster-tool readiness` is the manual, read-only preflight for a deployed
Wire network group. It uses the same Steps, PhaseGroups, orchestration engine,
and HTML Report infrastructure as cluster bootstrap and the existing
`flow-*` suites. It does not start a second test framework or require private
keys.

## Run it

Build the existing CLI once from the repository root:

```bash
corepack pnpm --filter @wireio/cluster-tool build
```

Every run requires the immutable deployment profile emitted for that exact
deployment. When the endpoint catalog knows the network group, the profile is
the only identity input:

```bash
corepack pnpm --filter @wireio/cluster-tool exec ./bin/wire-cluster-tool readiness \
  --feature swap \
  --outpost-deployment-profile-file <outpost-deployment-profile.json>
```

An operator can instead supply the Wire RPC and let the command discover its
chain id. Explicit external RPCs override catalog selection and are the most
reliable form immediately after a sandbox respin:

```bash
corepack pnpm --filter @wireio/cluster-tool exec ./bin/wire-cluster-tool readiness \
  --feature swap \
  --outpost-deployment-profile-file <outpost-deployment-profile.json> \
  --wire-rpc https://api-sim2.sandbox.wire-dev.com \
  --ethereum-rpc https://ethereum-sim2.sandbox.wire-dev.com \
  --solana-rpc https://solana-sim2.sandbox.wire-dev.com
```

The command exits `0` only when the selected feature's read-only preflight
passes. Any blocking check exits `1`. Optional endpoint-catalog or Hyperion
failures are advisories when the three required RPCs are available.

Useful output controls:

```bash
# The examples below abbreviate the repository-local prefix above.
# Stable machine report on stdout
wire-cluster-tool readiness ... --json

# Linux-friendly archive under ./readiness-reports/
wire-cluster-tool readiness ... --export

# Choose the archive directory
wire-cluster-tool readiness ... --export --export-dir /tmp/wire-reports

# Disable ANSI color explicitly
wire-cluster-tool readiness ... --no-color
```

The archive name includes the first 12 Wire chain-id characters and contains
exactly two files with the same basename:

- a schema-validated JSON readiness projection;
- the existing self-contained, colored orchestration Report HTML.

`readiness-reports/` is gitignored.

## Swap preflight coverage

Every run includes the network-group baseline:

- endpoint-catalog resolution and required Wire/Ethereum/Solana RPC selection;
- exact Wire chain identity, current head time, and observed block advancement;
- Ethereum chain identity and observed block advancement;
- Solana health, genesis identity, and observed slot advancement;
- exact Wire binding, Ethereum EIP-1967 implementations/code hashes, and Solana
  upgradeable-loader ProgramData/hash identity from the deployment profile;
- optional Hyperion health.

The swap suite then checks:

- required Wire swap contract ABIs, actions, and tables;
- active epoch scheduling;
- active EVM/SVM registry rows aligned with endpoint metadata.

It reads the typed `sdk-core` system-contract clients for the remaining
depot-state checks:

- valid underwriting fees, collateral lock duration, and WIRE-origin minimum;
- at least one `ACTIVE` underwriter satisfying every configured collateral
  minimum for every active external chain;
- deployed bytecode or mint accounts for non-native public reserve assets;
- active chain-token bindings for every funded public reserve;
- funded, active, non-private reserve books covering both EVM and SVM;
- every directional external-to-WIRE, WIRE-to-external, and cross-outpost route
  constructible from live registry state;
- a positive deterministic quote for every route using the canonical
  `WireReserveTool.cpOutput` implementation used by the swap FlowScenarios;
- no expired `PENDING` underwriting requests, while reporting the WIRE-origin
  queue size without inventing an expiry rule absent from `sdk-core`.

All independent checks run even after an earlier failure. The default
orchestration behavior remains fail-fast for bootstrap and existing flows;
readiness explicitly selects `ClusterBuildFailureMode.collect`.

## Verdicts and proof boundary

The JSON report separates:

- `clusterLive`: required discovery and cluster checks passed;
- `swapPreflightReady`: the read-only swap checks passed;
- `swapReady`: always `false` until a funded transaction canary settles;
- per-route `preflightReady` and `transactionallyVerified` evidence.

A green read-only preflight does **not** prove external custody, OPP daemon
circulation, destination settlement, balance reconciliation, idempotent retry,
or `SWAP_REVERT` refund behavior. Those require the later opt-in funded canary
using the existing swap FlowScenario architecture.

Readiness consumes `@wireio/sdk-outpost` as the typed compatibility boundary.
The immutable profile carries deployment identity and exact live runtime
fingerprints; the endpoint catalog remains a separate mutable routing concern.
A same-code respin creates a new profile without an artifact or SDK release.
Contract/program binary changes require producer-artifact releases and a new
profile; ABI/IDL changes additionally require an `sdk-outpost` release.

The readiness reason codes are the operator-report vocabulary in
`cluster-tool-shared`. They intentionally align with Hub feature-gate language,
but this unsigned manual artifact is not yet the Hub's authoritative capability
manifest.

## Stake status

`--feature stake` runs the same cluster baseline, then emits one blocking
`protocol-unavailable` Step. It performs no staking transaction and makes no
readiness claim while the canonical cross-chain LIQ stake/unstake lifecycle is
unavailable. Swap and stake can be selected independently.

## Architecture and future automation

The implementation is deliberately reusable:

- `Steps.readiness.cluster`, `Steps.readiness.outpostDeployment`, and
  `Steps.readiness.swap` own named, typed, read-only Step factories and runners;
- `ReadinessPhaseGroups.plan(...)` composes those Steps;
- `ReadinessContext` owns endpoint selection, `sdk-core` clients, and typed
  outputs;
- `ClusterBuild` executes the plan and produces the native Report;
- the JSON projector derives a stable operator contract from recorded Step
  evidence.

The manual CLI is the only entrypoint in this release. A future
`FlowScenario` should compose the same `ReadinessPhaseGroups` before live swap
flows so the existing E2E runner and GHA reports include identical readiness
evidence. Do not create another readiness runner or duplicate these assertions
inside GitHub Actions.
