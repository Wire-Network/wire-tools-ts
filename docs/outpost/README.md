# `wire-opreg-bootstrap.json`

Every cluster that `wire-cluster-tool create` (or any `flow-*` run) bootstraps writes
`wire-opreg-bootstrap.json` into its cluster directory. The file records:

- **which cluster it belongs to** — the cluster build label and the AWS account (environment) the
  cluster's nodes run in;
- **the bootstrapped operator roster** — every operator registered on `sysio.opreg` with
  `is_bootstrapped`, with its WIRE account name, operator type and public keys (each tagged with
  its key type);
- **the initial batch-operator schedule** — the batch-operator groups `sysio.epoch::schbatchgps`
  built, plus the index of the first active group;
- **the depot's epoch duration** — `sysio.epoch::epochcfg.epoch_duration_sec`.

It holds public data only: account names, public keys, addresses and proofs of possession. No
private key or secret reference is ever written to it.

| File | What it is |
|---|---|
| [`wire-opreg-bootstrap.schema.json`](wire-opreg-bootstrap.schema.json) | JSON Schema (draft 2020-12) of the file, generated from the zod schema |
| [`wire-opreg-bootstrap.example.json`](wire-opreg-bootstrap.example.json) | A file written by a local `create` run (1 producer, 3 batch operators), with `label` and `awsAccount` filled in the way a workflow-built `test` cluster carries them |

## When and where it is written

- **Path:** `<clusterPath>/wire-opreg-bootstrap.json`.
- **When:** during bootstrap, in the `EpochBootstrap` phase, right after
  `schedule-batch-groups` (`sysio.epoch::schbatchgps`) — the step `emit-wire-opreg-bootstrap`
  writes it, then `verify-wire-opreg-bootstrap` checks it against the depot. Both steps appear in
  the bootstrap Report.
- **Every mode:** local outposts and `--external-outpost-config` alike.
- **The label is set after the build.** `wire-cluster-tool` writes `"label": null`. The
  `create-wire-platform-cluster` workflow (`wire-platform-build-system`) sets it to the run's
  `WIRE_CLUSTER_LABEL` with `jq` once `create` succeeds, before it clones the external tree.
- `create-external-config` copies it into the external cluster directory unchanged (it carries no
  bind addresses or ports). `package` per-node archives do not include it.

## Format

```json
{
  "label": "testnet-epoch60",
  "awsAccount": "test",
  "epochDurationSec": 60,
  "operators": [
    {
      "accountName": "defproducera",
      "type": "PRODUCER",
      "keys": {
        "wire":          { "type": "K1",  "publicKey": "PUB_K1_…" },
        "wireFinalizer": { "type": "BLS", "publicKey": "PUB_BLS_…", "proofOfPossession": "SIG_BLS_…" }
      }
    },
    {
      "accountName": "wireno.a1b2c",
      "type": "BATCH",
      "keys": {
        "wire":     { "type": "K1", "publicKey": "PUB_K1_…" },
        "ethereum": { "type": "EM", "publicKey": "PUB_EM_…", "address": "0x…" },
        "solana":   { "type": "ED", "publicKey": "PUB_ED_…", "address": "<base58>" }
      }
    }
  ],
  "batchOperatorGroups": {
    "activeGroupIndex": 0,
    "groups": [["wireno.a1b2c"], ["wireno.d3e4f"], ["wireno.g5h1i"]]
  }
}
```

### Fields

| Field | Type | Meaning |
|---|---|---|
| `label` | string (`^[a-z0-9_-]+$`) \| `null` | The cluster build label — the `WIRE_CLUSTER_LABEL` of the `create-wire-platform-cluster` run that built the cluster. `null` for a cluster built outside that workflow |
| `awsAccount` | `"dev"` \| `"sandbox"` \| `"test"` \| `"prod"` \| `null` | The AWS account (environment) the cluster's nodes run in — `awsClusterNodeConfig.account` of the cluster config. `null` when the cluster has no AWS placement |
| `epochDurationSec` | integer > 0 | The depot's global epoch duration in seconds |
| `operators` | array (≥ 1) | Every bootstrapped operator, ordered by type (`PRODUCER`, `BATCH`, `UNDERWRITER`) then account name |
| `operators[].accountName` | WIRE name | The operator's on-chain account — the `sysio.opreg::operators` row key |
| `operators[].type` | `"PRODUCER"` \| `"BATCH"` \| `"UNDERWRITER"` | The operator type (the `OperatorType` member name) |
| `operators[].keys` | object | The operator's public keys. The entry's `type` fixes exactly which slots it carries: `wire` + `wireFinalizer` for a `PRODUCER`; `wire` + `ethereum` + `solana` for a `BATCH` / `UNDERWRITER`. Any other slot is rejected |
| `operators[].keys.wire` | `{ type: "K1", publicKey }` | The WIRE account key — every operator |
| `operators[].keys.wireFinalizer` | `{ type: "BLS", publicKey, proofOfPossession }` | The WIRE finality key — `PRODUCER` |
| `operators[].keys.ethereum` | `{ type: "EM", publicKey, address }` | The Ethereum key and its `0x` address — `BATCH` / `UNDERWRITER` |
| `operators[].keys.solana` | `{ type: "ED", publicKey, address }` | The Solana key and its base58 address — `BATCH` / `UNDERWRITER` |
| `batchOperatorGroups.groups` | array of arrays of WIRE names | The batch-operator window in slot order; each member is the `accountName` of a `BATCH` entry in `operators` |
| `batchOperatorGroups.activeGroupIndex` | integer ≥ 0 | Index into `groups` of the first active group |

Public keys are Wire-canonical (`PUB_<type>_…`); each key slot accepts only its own key type.
`label` and `awsAccount` are always present; a missing value is an explicit `null`.

### Semantics

- `groups[k]` serves epoch `k + 1`. The depot's genesis advance (epoch 0 → 1) does not move the
  window; it first slides on the 1 → 2 advance.
- `activeGroupIndex` is `0` when the file is written: the front of the depot's window is always the
  current group.
- Groups are disjoint by depot construction. The schema itself rejects only a repeat **within** one
  group.
- Producers that share a node share that node's `wire` key, so a public key can appear on more than
  one roster entry.
- `UNDERWRITER` is an admitted type, but the current depot refuses to register a bootstrapped
  underwriter, so today's files contain only `PRODUCER` and `BATCH` entries.
- A `keys` object accepts only its type's slots (`additionalProperties: false`). Every other object
  ignores unknown properties: the JSON Schema allows them and `WireOpregBootstrapSchemaCodec` strips
  them.

## Validating a file

**JSON Schema** — any draft 2020-12 validator, e.g. with ajv:

```js
const Ajv2020 = require("ajv/dist/2020")
const validate = new Ajv2020().compile(require("./wire-opreg-bootstrap.schema.json"))
validate(JSON.parse(fs.readFileSync("wire-opreg-bootstrap.json", "utf8")))
```

The JSON Schema checks each field, including each operator type's key slots (one `oneOf` variant
per type). Cross-field rules have no JSON Schema form and are enforced by the codec only:

- every `accountName` is unique;
- `activeGroupIndex` is within `groups`;
- no account repeats within a group;
- every group member is a `BATCH` entry in `operators`.

**TypeScript** — `@wireio/cluster-tool-shared` applies every rule:

```ts
import Fs from "node:fs"
import { WireOpregBootstrapSchemaCodec } from "@wireio/cluster-tool-shared"

const bootstrap = WireOpregBootstrapSchemaCodec.deserialize(
  Fs.readFileSync("wire-opreg-bootstrap.json")
)
// bootstrap.operators[n].type is the numeric OperatorType (@wireio/opp-typescript-models)
```

## Regenerating the JSON Schema

The zod schema in `packages/cluster-tool-shared/src/cluster/WireOpregBootstrap.ts` is the source.
After changing it:

```bash
pnpm build
./scripts/generate-json-schemas.mjs          # rewrites wire-opreg-bootstrap.schema.json
./scripts/generate-json-schemas.mjs --check  # exit 1 when the committed schema is stale
```

`pnpm test` fails while the committed schema differs from the source.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `emit-wire-opreg-bootstrap` fails: *no batch-operator schedule yet* | `sysio.epoch::schbatchgps` produced no groups — no ACTIVE batch operator was registered |
| `emit-wire-opreg-bootstrap` fails: *group member … is not a BATCH operator in operators* | `schbatchgps` scheduled a batch operator the bootstrap did not provision. It prefers non-bootstrapped ACTIVE batch operators, so one registered before `EpochBootstrap` lands in the window but not in the roster |
| `verify-wire-opreg-bootstrap` fails: *not the depot's set of bootstrapped operators* | An operator was registered on `sysio.opreg` as bootstrapped without being provisioned by the bootstrap (or the reverse) |
| `verify-wire-opreg-bootstrap` fails: *is not ACTIVE on sysio.opreg* | A bootstrapped operator's registration did not activate it |
| `verify-wire-opreg-bootstrap` fails: *schedule is not the depot's epochstate window* | The depot's window changed between the emit and the verify step |
| `verify-wire-opreg-bootstrap` fails: *AWS account is not the cluster's* | The file was rewritten between the emit and the verify step |
| `label` is `null` in a workflow-built cluster | The workflow's label step did not run — `create` failed, or the run predates the step |
| `generate-json-schemas.mjs` exits 2: *run pnpm build first* | The script reads the built `@wireio/cluster-tool-shared` package |
