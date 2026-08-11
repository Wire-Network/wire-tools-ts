# Connected cluster readiness

`wire-cluster-tool readiness` is a manually invoked, read-only preflight for a
deployed Wire network group. It does not require private keys and is not wired
into cluster bootstrap, flow execution, the Hub, or CI.

## Run it

Build the existing CLI once from the repository root:

```bash
corepack pnpm --filter @wireio/cluster-tool build
```

For the normal SIM2 check, pass only the Wire chain id. The tool asks the Network
API endpoint catalog for the matching Wire, Ethereum, and Solana RPCs:

```bash
corepack pnpm --filter @wireio/cluster-tool exec ./bin/wire-cluster-tool readiness \
  --feature swap \
  --wire-chain-id <64-character-wire-chain-id>
```

If the catalog is still catching up after a respin, supply the RPCs explicitly.
The Wire RPC is sufficient to discover the Wire chain id:

```bash
corepack pnpm --filter @wireio/cluster-tool exec ./bin/wire-cluster-tool readiness \
  --feature swap \
  --wire-rpc https://api-sim2.sandbox.wire-dev.com \
  --ethereum-rpc https://ethereum-sim2.sandbox.wire-dev.com \
  --solana-rpc https://solana-sim2.sandbox.wire-dev.com
```

Use an API-capable Wire endpoint for `--wire-rpc`. Live route quotes execute the
read-only `sysio.reserv::swapquote` action; a raw nodeop endpoint configured
with `read-only-threads = 0` can answer ordinary chain RPCs but cannot complete
this readiness surface. The endpoint catalog's SIM2 Wire record already points
to the API-capable endpoint.

The command exits `0` only when the selected feature's read-only preflight
passes. Any blocking check exits `1`. Optional endpoint-catalog or Hyperion
failures are advisories when the three required RPCs are available.

For stricter verification, optionally add the immutable deployment profile for
that exact respin:

```bash
corepack pnpm --filter @wireio/cluster-tool exec ./bin/wire-cluster-tool readiness \
  --feature swap \
  --wire-chain-id <64-character-wire-chain-id> \
  --outpost-deployment-profile-file <outpost-deployment-profile.json>
```

The strict mode verifies the live Ethereum proxy implementations, Solana
ProgramData, and exact external reserve custody against the addresses and
checksums in the profile. The ordinary chain-id run does not attempt exact
deployment identity or custody verification because RPC endpoint metadata does
not identify deployed contracts; it records custody as an advisory instead.

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
- a self-contained operator HTML report derived from that same projection.

The CLI and HTML use the same presentation model. Both lead with verified
configuration gaps, explicitly separate state the read-only command cannot
prove, summarize healthy collateral/custody/routes, and retain every check,
evidence payload, live quote, and per-route blocker for granular inspection.

`readiness-reports/` is gitignored.

## Swap preflight coverage

Every run includes the network-group baseline:

- endpoint-catalog resolution and required Wire/Ethereum/Solana RPC selection;
- exact Wire chain identity, current head time, and observed block advancement;
- Ethereum chain identity and observed block advancement;
- Solana health, genesis identity, and observed slot advancement;
- optional Hyperion health.

When `--outpost-deployment-profile-file` is supplied, the baseline additionally
checks exact Wire binding, Ethereum EIP-1967 implementations/code hashes, and
Solana upgradeable-loader ProgramData/hash identity.

The swap suite then checks:

- required Wire swap contract ABIs, actions, and tables;
- active epoch scheduling;
- active EVM/SVM registry rows aligned with endpoint metadata.

It reads the typed `sdk-core` system-contract clients for the remaining
depot-state checks:

- valid underwriting fees, collateral lock duration, and WIRE-origin minimum;
- a positive collateral requirement for every advertised `(chain, token)`
  bucket, with available balance computed as raw collateral minus active locks
  and pending withdrawals;
- at least one `ACTIVE` underwriter that covers every bucket on each direct
  route and both legs of each cross-outpost route;
- deployed bytecode or mint accounts for every advertised non-native public
  reserve asset;
- active chain-token bindings for every advertised public reserve, including
  zero-depth rows that would otherwise disappear from a funded-only filter;
- positive WIRE and external-token depot depth for every active, non-private
  reserve book, with coverage across both EVM and SVM;
- every directional external-to-WIRE, WIRE-to-external, and cross-outpost route
  constructible from live registry state;
- a positive live read-only `sysio.reserv::swapquote` result for every route,
  using the same `sdk-core` client as Hub so fee ordering and integer rounding
  match the user-visible quote;
- no expired `PENDING` underwriting requests, while reporting the WIRE-origin
  queue size without inventing an expiry rule absent from `sdk-core`.

Strict profile mode additionally checks exact external custody alignment for
every advertised reserve: Ethereum `ReserveManager` or Solana `liqsol_core`
token mapping, precision, initialized and active local reserve identity,
custody mint/address, positive custody balance, and positive local reserve
amount.

All independent checks run even after an earlier failure. The default
orchestration behavior remains fail-fast for bootstrap and existing flows;
readiness explicitly selects `ClusterBuildFailureMode.collect`.

## Verdicts and proof boundary

The JSON report separates:

- `clusterLive`: required discovery and cluster checks passed;
- `swapPreflightReady`: the read-only swap checks passed;
- `swapReady`: always `false` until a funded transaction canary settles;
- per-route `preflightReady` and `transactionallyVerified` evidence.

A green ordinary preflight proves the depot-side reserve, route, quote,
underwriter, epoch, and backlog state visible through the selected RPCs. Strict
profile mode also proves the exact deployment identity and current external
custody snapshot. Neither mode provisions or proves a disposable test wallet's
gas/token balances, allowances, associated token accounts, OPP daemon
circulation, destination settlement, retry/idempotency, terminal Solana payout
behavior, or the durable/partial `SWAP_REVERT` refund lifecycle.

Readiness consumes `@wireio/sdk-outpost` as the typed compatibility boundary.
A deployment profile is the contract/program address book: it carries
deployment identity, addresses, and exact live runtime fingerprints. The latest
`sdk-outpost` deliberately does not publish environment addresses; it validates
caller-supplied profiles and provides typed ABI/IDL clients. Today those
profiles are emitted as deployment artifacts and must be supplied as a file.
The clean publication path is for each Network API network-group record to
reference the immutable profile id and URL while keeping mutable RPC endpoints
separate. Until that catalog field exists, this CLI does not guess addresses or
fall back to old SDK constants.

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

## Implementation boundary

The command uses the existing readiness Steps, PhaseGroups, context, and Report
projection internally. That is an implementation detail, not an integration
requirement.

- `Steps.readiness.cluster`, `Steps.readiness.outpostDeployment`, and
  `Steps.readiness.swap` own named, typed, read-only Step factories and runners;
- `ReadinessPhaseGroups.plan(...)` composes those Steps;
- `ReadinessContext` owns endpoint selection, `sdk-core` clients, and typed
  outputs;
- `ClusterBuild` executes the plan and produces the native Report;
- the JSON projector derives a stable operator contract from recorded Step
  evidence.

The manual CLI is the only entrypoint in this release. No flow, bootstrap, Hub,
or GitHub Actions integration is planned by this change.
