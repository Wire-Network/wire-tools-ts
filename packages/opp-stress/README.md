# OPP stress schema-v1 evidence

`@wireio/test-opp-stress` writes self-contained, offline-verifiable evidence for
one OPP saturation ramp. This is the operator and developer contract for that
evidence; it does not change the package entrypoint or global CI formats.

## Health and collection policy

The stress path uses the strict OPP integrity reader, not tolerant debugging
list/get/load/watch behavior. A strict candidate contributes only after its
canonical base key, raw data, metadata, checksums, decoded epochs, and file
identity are valid. The reader records malformed, missing, changed, or
symlinked candidates as structured telemetry; it never converts them into
saturation credit. Tolerant debugging APIs retain their existing best-effort
behavior and are not an authority for a stress decision.

Each canonical base key is exactly
`<8-decimal-epoch-digits>-<endpoint-enum-name>-<16-lowercase-hex-checksum>`.
The endpoint segment must be a known `DebugOutpostEndpointsType` enum name that
round-trips to the same name; aliases, `UNKNOWN`, and unknown names are invalid.
The checksum is the first 16 hex digits of the full lowercase SHA-256 of the
exact `.data` bytes. The metadata's numeric checksum must equal the first 12 of
those digits, and the epoch decoded from `.data` must equal the key's numeric
epoch. Every committed data, metadata, config, setup, iteration, and terminal
reference stores its own full SHA-256.

Before phase work starts, the strict reader captures all-key membership in
`baseKeys` and its baseline identity. Optional immutable refs identify only
artifacts already committed for selected or persisted evidence, not every
baseline key. Phase evidence may select only new, committed, fully validated
keys outside that baseline. Accepted pairs are ordered by epoch, envelope index,
then base key.
File mtime is diagnostic identity/race data only; it never decides phase
membership, freshness, ordering, or saturation credit.

Before the exact 240,000 ms deadline, every non-healthy strict observation is
pre-terminal and retried every 3,000 ms, including every integrity issue class.
A repair observed at the final legal poll is accepted. `degraded` is created
only after exact deadline exhaustion; it is terminal, grants no credit, and
preserves the cluster. `healthy` is the only clean decision state. Persistent
required non-healthy evidence becomes typed telemetry-integrity breakage and is
never reported as clean saturation.
Callback/workload, infrastructure, invalid-observation, and telemetry-integrity
breakage are likewise terminal failures, preserve the cluster, and never grant
missing endpoint credit.

## Layout, lifecycle, and persistence

Allocation uses the canonical cluster path and creates a distinct sibling:

```text
<cluster-path>-swap-stress-evidence/
  runs/<uuid-v4>/
    manifest.json
    cluster-config.snapshot.json       # only after config capture
    setup.json                         # only after setup publication
    iterations/000000.json             # six-digit, contiguous, zero based
    terminal.json                      # only after terminal publication
    artifacts/opp/<baseKey>.data      # immutable raw bytes
    artifacts/opp/<baseKey>.metadata  # immutable metadata bytes
```

There are no legacy root `iteration-N.json` files, flat iteration files, or
per-key artifact directories: schema v1 stores artifact files flat directly
under `artifacts/opp/`. The manifest is the authority for the exact clean tree:
each declared record and artifact must exist, hash to its declared digest, be
canonical JSON where applicable, be a contained relative path, and be neither a
symlink nor an undeclared extra entry.

A newly allocated manifest is `initializing`, has `records.setup.kind: "pending"`,
no iterations or terminal, empty artifacts, empty retryable telemetry, and
`clusterConfigSnapshot.kind: "pending"`. Pending config is legal only while
initializing. After config capture, every later lifecycle uses `captured` with
the relative snapshot path and full hash. `unavailable` is legal only for a
pre-config setup failure and has reason `cluster_config_not_created`; a setup
failure after capture retains `captured`. Setup success moves to `running`.
`failed` preserves for diagnosis; clean `incomplete` preserves with healthy
telemetry and missing endpoints; `saturated` has healthy telemetry, no missing
endpoints, and `preserveCluster: false`.

The manifest contains identity (`schemaVersion`, `runId`, `lifecycle`), decimal
string timestamps, normalized `clusterPath`, cluster preservation, ramp config,
required/saturated/missing endpoint partitions, telemetry, runtime identity,
normalized provenance paths, lifecycle-compatible config state, record refs,
and artifacts. Each artifact has its canonical `baseKey`, relative full-hash
`.data` and `.metadata` `firstImmutableRefs`, first and last accepted decimal
observation ordinals, and sorted latest accepted batch-operator names. Each
phase has a unique label, endpoint, saturation strategy, all-key baseline,
decimal-string time/epoch window, relative artifact refs, telemetry, status,
and recomputable metrics. The manifest has no self-hash.

Publication writes a unique same-directory temporary file, writes all bytes,
syncs the file, and closes it before the commit point. The initial
`manifest.json` and every immutable file publish through create/link, so an
existing destination is never replaced. Only subsequent `manifest.json`
checkpoints publish through replace/rename, after every newly referenced
immutable file is committed. The parent directory is synced where the platform
supports directory sync.

A failure before link/rename leaves the old checkpoint or no new immutable
destination. Every failure after link/rename, including temporary unlink and
directory open/sync/close, reports `committed: true`: the complete final file is
authoritative and an immutable-link failure may leave a residual temporary
entry. Persistence fails closed, preserves the run and cluster, performs no
later publication, and never pretends to roll back a committed final. Treat the
error as an investigation event, not permission to overwrite evidence.

Strict-reader source bytes are untrusted. AtomicFile destination directories,
including the manifest parent, must be process-owned and trusted against
concurrent same-UID namespace mutation. AtomicFile rejects symlinked paths at
its API boundary and provides crash-safe consistency, cooperating-writer
atomicity, and truthful commit and durability diagnostics, not cryptographic
authenticity. An actor that can rewrite the destination directory or manifest is
outside this contract and requires native descriptor-relative operations,
signatures, or a storage redesign.

## Parser-valid schema-v1 manifest

This is a complete `initializing` manifest accepted by the runtime
`parseRunEvidenceManifest` parser. Decimal timestamps are strings to avoid JSON
number precision loss. Paths are absolute and normalized; the UUID is lowercase
v4; endpoint sets are unique and partition required endpoints.

```json
{
  "schemaVersion": 1,
  "runId": "9f1c2a30-8b44-4d55-9a66-123456789abc",
  "lifecycle": "initializing",
  "startedAtMs": "18446744073709551615",
  "updatedAtMs": "18446744073709551615",
  "clusterPath": "/var/tmp/wire-stress-cluster",
  "rampConfig": {
    "initialCount": 3,
    "multiplier": 3,
    "maxCount": 243,
    "phaseTimeoutMs": 240000
  },
  "requiredEndpoints": ["DEPOT_OUTPOST_ETHEREUM"],
  "saturatedEndpoints": [],
  "missingEndpoints": ["DEPOT_OUTPOST_ETHEREUM"],
  "preserveCluster": true,
  "telemetry": {
    "kind": "empty",
    "retryable": true,
    "candidateCount": 0,
    "validCount": 0,
    "filteredCount": 0,
    "issueCount": 0,
    "issues": []
  },
  "runtime": {
    "nodeVersion": "v24.8.1",
    "platform": "linux",
    "architecture": "arm64"
  },
  "provenance": {
    "wireBuildPath": "/var/tmp/wire-build",
    "ethereumPath": "/var/tmp/wire-ethereum",
    "solanaPath": "/var/tmp/wire-solana"
  },
  "clusterConfigSnapshot": { "kind": "pending" },
  "records": {
    "setup": { "kind": "pending" },
    "iterations": [],
    "terminal": null
  },
  "artifacts": []
}
```

## Build, make a real temporary run, and verify it offline

The leading verifier syntax is exactly
`pnpm --filter @wireio/test-opp-stress exec node scripts/verify-evidence.mjs <runDir>`.
Run the executable commands below from `r/wire-tools-ts`. They use emitted code;
the temporary allocation intentionally remains `initializing`, so the verifier
report is valid but its CLI exit is `1` (`verified_in_progress`), not `0`. Exit
`0` is reserved for a valid, independently recomputed saturated run.

```bash
pnpm --filter @wireio/test-opp-stress build
RUN_ROOT="$(mktemp -d /tmp/opp-stress-evidence-XXXXXX)"
mkdir -p "$RUN_ROOT/cluster"
printf '{"temporary":true}\n' > "$RUN_ROOT/cluster/cluster-config.json"
RUN_DIR="$(RUN_ROOT="$RUN_ROOT" node --input-type=module <<'NODE'
import OppStress from "./packages/opp-stress/lib/out/index.js"

const root = process.env.RUN_ROOT
const persistence = await OppStress.RunEvidencePersistence.allocate({
  clusterPath: `${root}/cluster`,
  rampConfig: { initialCount: 3, multiplier: 3, maxCount: 243, phaseTimeoutMs: 240000 },
  requiredEndpoints: [OppStress.RunEvidenceEndpoint.DepotOutpostEthereum],
  provenance: {
    wireBuildPath: "/var/tmp/wire-build",
    ethereumPath: "/var/tmp/wire-ethereum",
    solanaPath: "/var/tmp/wire-solana"
  },
  startedAtMs: "1"
})
process.stdout.write(persistence.runDirectory)
NODE
)"
pnpm --filter @wireio/test-opp-stress exec node scripts/verify-evidence.mjs "$RUN_DIR" --json; test "$?" -eq 1
```

The leading documented command takes exactly one absolute normalized positional
run directory. The equivalent named form is accepted; `--json` is optional.
For exit-code-sensitive automation, invoke the verifier process directly from
`r/wire-tools-ts` as
`node packages/opp-stress/scripts/verify-evidence.mjs <runDir> [--json]`.
The direct process exits `1` for `verified_in_progress` and exits `2` after
printing usage for duplicates, mixed positional and `--run-dir` forms, missing
values, relative or non-normalized paths, a literal `--`, and unknown flags.
The package-filter `pnpm` command remains convenient for ordinary use, but
normalizes those failing direct-process exits to `1`.

```bash
pnpm --filter @wireio/test-opp-stress exec node scripts/verify-evidence.mjs --run-dir "$RUN_DIR" --json; test "$?" -eq 1
```

It is offline: it does not read the mutable cluster or provenance paths. It
pins the run directory, rejects symlinks/races/extra entries, checks exact
canonical bytes and hashes, parses every lifecycle record, recomputes raw-pair
validity, phase metrics, endpoint partition, and terminal decision. Its report
also labels the limited publisher claims that later immutable bytes cannot
independently prove.

Validate the fenced example with the actual emitted parser:

```bash
README_PATH="$PWD/packages/opp-stress/README.md" node --input-type=module <<'NODE'
import Fs from "node:fs"
import OppStress from "./packages/opp-stress/lib/out/index.js"

const text = Fs.readFileSync(process.env.README_PATH, "utf8")
const match = text.match(/```json\n([\s\S]*?)\n```/)
if (match === null) throw new Error("schema-v1 JSON fence not found")
const parsed = OppStress.parseRunEvidenceManifest(JSON.parse(match[1]))
if (!parsed.ok) throw new Error(`manifest rejected: ${parsed.error.code}`)
process.stdout.write("README_SCHEMA_V1_PARSE=PASS\n")
NODE
rm -rf "$RUN_ROOT"
```

## Failure recovery

Keep the run directory and preserved cluster on any non-success, durability
warning, parser rejection, or verifier issue. First run the offline verifier
against the exact run directory and retain its JSON report; inspect the declared
hash/path/record issue rather than editing files in place. Do not replace an
immutable file, rewrite a manifest, follow a symlink, or promote tolerant-reader
output to proof. After copying the evidence and logs to durable incident
storage, create a new cluster/run for a retry. Clean only an independently
verified saturated run when its controller selected `preserveCluster: false`.
