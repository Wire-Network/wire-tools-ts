# Wire production bootstrap sequence

Canonical, ordered list of on-chain actions to bootstrap a Wire chain, with **every** value each action
passes specified inline. The cluster tooling (`wire-tools-ts`,
`packages/cluster-tool/src/orchestration/ClusterBuildDefaults.ts` + `packages/cluster-tool/src/Constants.ts`;
`cluster/ClusterManager.ts` wraps the build with the filesystem/process lifecycle) is the source of truth for
the concrete values shown here; this document is meant to be read **stand-alone** — no value requires opening
the code.

**What "the values" are.** The concrete numbers/strings below are the cluster tooling's *production-mirror
defaults*. They split into two kinds:
- **Structural / fixed** — core symbol, chain/token codes, ROA byte price, operator caps, authority shapes,
  the `setemitcfg` split ratios. Production keeps these.
- **Deployment-tunable / dev stand-in** — keys, the finalizer set, supplies, epoch duration, collateral
  amounts and lock windows, the external (ETH/SOL) chain ids, mock token contract addresses, syndication
  bucket sizes and challenge window, operator/producer counts. Production substitutes real keys, the real finalizer set, real external
  chain ids/addresses, and final economic policy. Each such value is flagged **(cluster; production: …)**.

## Conventions
- `account::action` — the contract account the action lives on. NOTE: `bios` and `system` both deploy to the
  **`sysio`** account itself (no separate `sysio.bios`/`sysio.system` account); `system` replaces `bios`.
- Auth in `[brackets]` — the `-p` authorization.
- **raw** = `sysio::setcode` + `sysio::setabi` (the `sysio`-account contracts `bios`/`system`, plus `sysio.roa`).
- **sys** = `sysio.roa::setsyscode({account, vmtype:0, vmversion:0, code:<wasm hex>})` (inline
  `setcode`+`setpriv`+`giftram`) + `sysio.roa::setsysabi({account, abi:<packed abi_def hex>})` (inline
  `setabi`+`giftram`). Privileged + RAM gifted from the `sysio` pool; requires ROA active; cannot target
  `sysio` (giftram self-reference). `code` = raw wasm bytes (hex); `abi` = PACKED `abi_def` bytes;
  `vmtype = vmversion = 0`. Both actions are signed `[sysio@active]`.
- **slug(X)** — the `slug_name` codename for string `X`, packed into the `{ value: <uint64> }` shape the
  regenerated ABI emits. Chain/token codes are slug names.

## RAM model — no unlimited accounts
Every account's RAM is **finite** and **gifted from the `sysio` pool** as a conserving transfer (never minted):
- **`activateroa`** partitions the total RAM into node-owner reserves + `sysio.roa` allocation (`leftover/2`) +
  the `sysio` pool + the `sysio.acct` seed, and sets finite limits on `sysio`, `sysio.roa`, `sysio.acct`. Total
  RAM = `total_sys.amount * bytes_per_unit` — the asset's **smallest units**, NOT the display value. The tier
  reserves are *fractions* of supply (per node: T1 4%, T2 0.15%, T3 0.003%; × the tier caps 21 / 84 / 1000 ⇒
  **99.6% of supply**), so only **0.4%** is left for everything else, at any scale. With the cluster defaults
  (`75496.0000 SYS` ⇒ amount `754,960,000`, `bytes_per_unit = 104`) total RAM ≈ `754,960,000 * 104` ≈
  **78.5 GB**: ~66 GB reserved across 21 T1 owners (~3.1 GB each), ~9.9 GB T2, ~2.4 GB T3, and a ~314 MB
  leftover split into `sysio.roa` ≈ 157 MB + the `sysio` bootstrap pool ≈ 157 MB (+ a 1144-byte `sysio.acct`
  seed). So `total_sys` sets the **absolute** RAM budget — the split is ratiometric, but the bytes are real:
  the leftover pool must clear the bootstrap's fixed RAM costs (every contract's code/abi + each account's
  `newaccount_ram = 1144 B`), which is why the supply is tuned to this value, not arbitrary.
- **Account creation** (`system::native::newaccount`): `set_resource_limits(new, 0,0,0)` then
  `transfer_ram(sysio, new, newaccount_ram)` — the new account gets a finite limit funded from the pool. This
  requires `system` deployed AND ROA active, so all non-essential accounts are created **after** Stage 4.
- **Contract code/abi** (**sys** deploy → `giftram`): tops up the contract account's limit by exactly the
  code/abi bytes from the pool. `giftram` REJECTS a non-finite target (`"giftram target must have a finite
  RAM limit"`), so the account must already be finite.
- **System-contract table rows** — config/state/registration/log rows on the separate-account system
  contracts (`sysio.token` plus the OPP set, Stage 8) — are billed directly to `sysio` via a per-contract `ram_payer = "sysio"_n` (privileged-contract
  model). `setsyscode`'s `giftram` covers only code/abi, so a self-billed row would overflow the contract's
  exact limit; routing rows to the pool keeps each contract account finite at code/abi size. `bios`/`system`
  code lives on `sysio` and likewise consumes the pool directly.
- **Only transiently unlimited** during bring-up: `sysio` (genesis), `sysio.roa`, `sysio.acct` — all set
  finite by `activateroa`. No account is permanently unlimited.
- Invariant: `sysio` pool remaining + `sysio.acct` bucket == initial pool; grand total across {node-owner
  reserves + roa allocation + `sysio` pool + every gifted account/contract} == `total_sys * bytes_per_unit`.

## Governance & privilege
- **All `sysio.*` accounts: owner = active = `sysio@active`** — an account-authority delegating to `sysio`:
  `{threshold:1, keys:[], accounts:[{permission:{actor:"sysio",permission:"active"},weight:1}], waits:[]}`; no
  standalone key. Governance (`sysio`, msig-backed in production) controls every system account and signs every
  `[sysio.X@active]` step. Stage 8 only ADDs `@sysio.code` weights on the eleven OPP accounts' **owner**
  authorities on top of that `sysio@active` base (never removing it). No other authority is rewritten during
  the bootstrap.
- The root **`sysio`** account is the one exception: its own `active` authority carries a **standalone key**
  from genesis (cluster: `DEV_K1`; production: the governance key / msig) and is never rewritten. It is never
  a `sysio@active` self-reference.
- All system contracts are privileged: `sysio`/`bios`/`system` from genesis; the **sys**-deployed set via
  `setsyscode`. Hard requirements (from source): `sysio.token` (bills rows to `sysio`), `sysio.msig`,
  `sysio.wrap` (both `act.send()` arbitrary-auth actions).

---

## Reference constants & identities
Single source of truth for the cross-cutting scalars; the stages reference these by name.

### Keys & identities (cluster dev keys — production substitutes real keys / msig)
The dev key material is never spelled out — each key derives deterministically from a hashed seed name:

```text
DEV_K1  = K1.regenerate(SHA256("nathan"))     # secp256k1
DEV_BLS = BLS.regenerate(SHA256("wire"))      # BLS12-381 finalizer key
```

| Constant | Role | Value |
|---|---|---|
| `DEV_K1_PUBLIC_KEY` | Genesis `initial_key` (bios block-signing key); the standalone key on `sysio`'s own `active`; owner/active of node owner `wireno` — see note ¹. | `DEV_K1.publicKey` (SYS-prefixed legacy spelling) |
| `DEV_K1_PRIVATE_KEY` | Matching private key; imported into the `default` kiod wallet. | `DEV_K1.privateKey` (WIF spelling) |
| `DEV_BLS_PUBLIC_KEY` | Genesis `initial_finalizer_key` (bios finalizer). | `DEV_BLS.publicKey` (`PUB_BLS_*` spelling) |
| `DEV_BLS_PROOF_OF_POSSESSION` | PoP for `DEV_BLS_PUBLIC_KEY`. | `DEV_BLS.proofOfPossession` (`SIG_BLS_*` spelling) |
| Per-node K1/BLS keys | Producer nodes' own block-signing (K1) + finalizer (BLS) keys, distinct from `DEV_*`; used by `setprodkeys` / `setfinalizer` AND as the producer accounts' owner/active keys. | generated at runtime (`clio create key --k1`, `sys-util bls create key`) |
| Per-operator K1/EM/ED keys | Each batch operator's UNIQUE identity: a WIRE account key (K1, imported into kiod so `<account>@active` signs), an ETH key (EM, anvil-mnemonic HD-derived), and a SOL key (ED25519). The chain ACCOUNT is node-owner-generated (`wireno.<suffix>` via `roa::newuser`); the deterministic labels (`batchop.a`, …) are the newuser sponsor nonces + the tooling's keystore keys. | generated at runtime (`KeyGenerator`) |
| `BOOTSTRAP_NODE_OWNER` | Bootstrap tier-1 node owner (2–6 chars to satisfy `valid_name_for_tier`); its tier-1 reserve is what post-bootstrap resource policies are issued from. | `wireno` |
| `DEFAULT_WALLET_NAME` | kiod wallet the bootstrap creates and every helper re-opens. | `default` |

¹ **`DEV_K1` derivation & governance scope.** `DEV_K1_PUBLIC_KEY` is `K1` regenerated from `SHA256("nathan")` (the well-known dev key, SYS-prefixed). It is the genesis block-signing key, the standalone key on `sysio`'s own `active`, and the owner/active key of node owner `wireno` — nothing else. Producer accounts are keyed by their **hosting node's generated K1**, operators (`batchop.*`) by their **own per-operator generated K1**, and the `sysio.*` system accounts (and `dev.owner1`) by `sysio@active` — production substitutes real keys / msig throughout.

### Core symbol, tokens & supplies
| Constant | Value |
|---|---|
| `CORE_SYMBOL_SPEC` | `4,SYS` (precision 4, symbol `SYS`) |
| SYS `maximum_supply` / initial `issue` | `1000000000.0000 SYS` (1e9) each, issued to `sysio` |
| `PRODUCER_INITIAL_FUNDS` | `1000000.0000 SYS` transferred to each producer |
| WIRE token | symbol `9,WIRE`; `maximum_supply` / initial `issue` = `1000000000.000000000 WIRE`, issued to `sysio` |

### ROA & RAM pool
| Constant | Value |
|---|---|
| `activateroa.total_sys` | `75496.0000 SYS` **(cluster; production: real pool sizing)** |
| `ROA_BYTES_PER_UNIT` | `104` (fixed) |

### Resource-policy weights (`sysio.roa::addpolicy`, issued as `wireno`) — NOT part of the bootstrap
The bootstrap registers `wireno` (Stage 10) so its tier-1 reserve can issue these policies. It issues exactly
one itself — to the `sysio.andon` panic account (Stage 10b); flows/tools provision users and non-bootstrapped
operators with them post-bootstrap:

| Field | Value |
|---|---|
| `net_weight` / `cpu_weight` (`DEFAULT_RESOURCE_WEIGHT`) | `25.0000 SYS` |
| `ram_weight` (`DEFAULT_RAM_WEIGHT`) | `25.0000 SYS` |
| `time_block` | `0` |
| `network_gen` | `0` |

### Operator / epoch sizing
| Constant | Value | Notes |
|---|---|---|
| `producerCount` | `21` (`MAX_PRODUCERS`) | accounts `defproducera … defproduceru` |
| `nodeCount` | `1` **(cluster)** | producer nodes hosting the producers |
| `batchOperatorCount` | `3` **(cluster)** | labels `batchop.a/b/c` (chain accounts are `wireno.<suffix>`, node-owner-generated) |
| `underwriterCount` | `0` | swap-underwriter daemons have been removed; any nonzero value is rejected |
| `apiCount` | `0` **(cluster)** | non-producing API nodes serving the chain API + `/v1/query/execute` |
| `epochDurationSec` | `90` **(cluster; production: real cadence)** | |
| `EnvelopeLogRetentionEpochs` | `10` | `sysio.epoch::setconfig.epoch_retention_envelope_log_count` |

---

## Stage 1 — Core chain bring-up (bios on `sysio`, raw)
1. deploy `bios` → `sysio` — **raw** — `[sysio@active]` — `setcode`/`setabi(sysio, bios.wasm/abi)`.
2. `sysio::activate(feature_digest)` — `[sysio@active]` — for **every** digest returned by the bios node's
   `GET /v1/producer/get_supported_protocol_features`, **except** `PREACTIVATE_FEATURE`. That feature is
   effectively active from genesis — wire-sysio whitelists the `preactivate_feature` intrinsic in its genesis
   intrinsic set — so the tooling simply skips its digest; no producer-API scheduling step exists. "already
   activated" errors are benign and ignored.
3. `sysio::setfinalizer({finalizer_policy:{threshold, finalizers:[…]}})` — `[sysio@active]` — a bios-ABI
   action, so it runs before `system` replaces `bios` in Stage 3:
   - `threshold = floor(N*2/3) + 1`, where `N` = number of producer **accounts** (`producerCount = 21` ⇒
     `threshold = 15`).
   - each finalizer `= {description:<producer account name>, weight:1, public_key:<that account's own BLS
     pubkey>, pop:<its BLS proof-of-possession>}`. Every producer account owns a BLS finalizer key minted for
     it before any node starts (its block-signing K1 stays shared with its hosting node); these are not
     `DEV_BLS` (which is only the genesis/bios finalizer). The policy is keyed on accounts, not nodes,
     because `sysio.system` rebuilds the finalizer policy from the keys accounts registered via `regfinkey`
     (step 23) the first time producer ranking publishes; a node-keyed genesis policy would be replaced by
     one the running nodes hold no key for.
   The chain finalizes on these keys and keeps producing on the genesis `sysio` producer until the Stage 5
   handoff — no early `setprods`/`setprodkeys` (producer accounts don't exist on chain pre-pool).

## Stage 2 — Bring-up-essential accounts only (native `newaccount`, pre-ROA)
4. `sysio::newaccount({creator:"sysio", name, owner:sysio@active, active:sysio@active})` — `[sysio@active]` —
   create only what Stage 3/4 needs: **`sysio.roa`** (to host the contract) and **`sysio.acct`** (activateroa
   seeds its bucket). Both `owner = active = sysio@active` (the delegating authority above). These are
   transiently unlimited (bios doesn't gift); `activateroa` sets both finite next. Nothing else is created
   pre-pool.

## Stage 3 — Replace genesis contract path: deploy `system` (on `sysio`, raw)
5. deploy `system` → `sysio` — **raw** — `[sysio@active]` — replaces bios; billed to `sysio` (pool quota).
   Enables the RAM-gifting `system::native::newaccount` for Stage 5.

## Stage 4 — ROA activation (establishes the RAM pool; makes sysio/roa/acct finite)
6. deploy `sysio.roa` → `sysio.roa` — **raw** — `[sysio@active]`.
7. `sysio::setpriv("sysio.roa", 1)` — `[sysio@active]`.
8. `sysio.roa::activateroa({total_sys:"75496.0000 SYS", bytes_per_unit:104})` — `[sysio.roa@active]` — **RAM
   POOL ESTABLISHED**; sets finite limits on `sysio`, `sysio.roa` (`leftover/2`), `sysio.acct` (seed). No node
   owner is registered here; `forcereg` is never used — node owners enter ONLY via the real `nodeownreg` flow
   (Stage 10).

## Stage 5 — Create ALL remaining accounts (pool-gifted, finite) + producer handoff
Every account here is created via `system::native::newaccount`, which gifts `newaccount_ram` from the `sysio`
pool (`set_resource_limits(new,0,0,0)` + `transfer_ram(sysio,new,newaccount_ram)`) — each is FINITE, never
unlimited.

9. **Producer accounts** — `sysio::newaccount({creator:"sysio", name, owner:<node K1>, active:<node K1>})`
   × 21 — `[sysio@active]` — names `defproducera … defproduceru`. Each producer account is keyed by its
   **hosting node's generated K1** — the same key `setprodkeys` schedules below (cluster single-node: all 21
   share `node_00`'s key) **(cluster; production: each producer's real key)**. RAM is pool-gifted like
   everything else.
10. **Remaining `sysio.*` accounts** — `sysio::newaccount({creator:"sysio", name, owner:sysio@active,
    active:sysio@active})` — `[sysio@active]` — every entry of the system-account set except `sysio.roa` /
    `sysio.acct` (created in Stage 2):

| Group | Accounts |
|---|---|
| System / authority | `sysio.noop`, `sysio.bpay`, `sysio.msig`, `sysio.names`, `sysio.token`, `sysio.vpay`, `sysio.wrap`, `sysio.authex` |
| OPP set | `sysio.chains`, `sysio.tokens`, `sysio.epoch`, `sysio.opreg`, `sysio.msgch`, `sysio.chalg`, `sysio.dclaim`, `sysio.swap`, `sysio.liq`, `sysio.andon`, `sysio.bond`, `sysio.synd` |
| T5 buckets | `sysio.gov` (governance), `sysio.ops` (capex/ops) |
| Dev-only (cluster) | `dev.owner1` |
11. `sysio::setprodkeys({schedule:[{producer_name, block_signing_key}…]})` — `[sysio@active]` — one row per
    producer; `block_signing_key` = the **generated K1 pubkey of the node hosting that producer** (the same
    key the account is keyed with; cluster single-node: all 21 map to that one node's key). Then poll
    `get_info` until `head_block_producer != "sysio"` (handoff; 90 s timeout) — the genesis `sysio` producer
    hands off to the real schedule.

## Stage 6 — Token contract + SYS supply (sysio.token via sys deploy)
12. deploy `sysio.token` — **sys** — `[sysio@active]`.
13. `sysio.token::create({issuer:"sysio", maximum_supply:"1000000000.0000 SYS"})` — `[sysio.token@active]`.
14. `sysio.token::issue({to:"sysio", quantity:"1000000000.0000 SYS", memo:"initial issue"})` — `[sysio@active]`.
15. `sysio.token::transfer({from:"sysio", to:<producer>, quantity:"1000000.0000 SYS", memo:"init"})` × 21
    producers — `[sysio@active]`.

## Stage 7 — `sysio.authex` + msig/wrap (sys deploys; no auth rewrites, no init)
16. deploy `sysio.authex` — **sys** — `[sysio@active]`.
17. deploy `sysio.msig`, then `sysio.wrap` — **sys** — `[sysio@active]` — no `sysio.code` grant needed
    (`setsyscode` already deploys them privileged).

There is NO `sysio::init` action and NO authority rewrite in this stage: `sysio`'s active keeps its genesis
standalone key, and `sysio.authex` keeps the plain `sysio@active` owner/active it was created with (no
`@sysio.code` weight on either).

## Stage 8 — OPP contracts + owner `sysio.code` grants
18. deploy the OPP set — **sys** — `[sysio@active]`, in order: `sysio.chains`, `sysio.tokens`, `sysio.epoch`,
    `sysio.opreg`, `sysio.msgch`, `sysio.chalg`, `sysio.dclaim`, `sysio.andon`, `sysio.swap`, `sysio.liq`,
    `sysio.bond`, `sysio.synd`. `sysio.andon` precedes the four contracts that read its cord (swap, liq, bond,
    synd), `sysio.bond` precedes `sysio.synd`, and `sysio.synd` precedes the first liq-token registration
    (Stage 11).
19. `sysio::updateauth` on **each OPP account's owner** (`grantSysioCode`) — `[<account>@owner]` — owner ←
    `{threshold:1, keys:[], accounts:[{sysio@active,1},{<account>@sysio.code,1}], waits:[]}` (sorted by name
    value; `sysio` sorts first). (11 calls: every OPP account except `sysio.andon`, which sends no inline
    actions.) Lets each contract inline-send its own actions (epoch `advance`, `evalcons`, `dispatch`, …)
    while staying governed by `sysio@active`.

These eleven owner grants are the ONLY authority rewrites in the bootstrap. The former cross-contract
active-permission delegations (`@sysio.code` weights for `sysio.msgch` on opreg/roa and for `sysio.roa` on
authex) are no longer configured.

`sysio.dclaim` must be deployed before the first `sysio.authex::createlink` or `recordlink`. Both link
actions inline `sysio.dclaim::linkswept`. User-signed `createlink` checks that DClaim is deployed and
privileged before inserting the link, and the inline sweep is atomic with that insertion. Trusted bootstrap
or remediation calls to `recordlink` retain the soft-failure path: when DClaim is unavailable, they commit
the link and leave pre-link rewards in `unmapped_tokens` for operator remediation. The **sys** deploy above
uses `sysio.roa::setsyscode`, which grants privilege as part of deployment, so this ordering—not a separate
`setpriv` action—is the production precondition. This bootstrap satisfies it: DClaim is deployed in Stage 8
before the first node-owner link in Stage 10 and operator `createlink` calls in Stage 12.

## Stage 9 — OPP / application configuration (epoch, opreg, genesis producer registration, emissions, dclaim)
20. `sysio.epoch::setconfig({epoch_duration_sec:90, operators_per_epoch:1,
    batch_operator_minimum_active:3, batch_op_groups:3, epoch_retention_envelope_log_count:10})` —
    `[sysio.epoch@active]`. Sizing is computed from the operator counts:
    `batch_op_groups = min(3, batchOperatorCount)`, `operators_per_epoch = ceil(batchOperatorCount /
    batch_op_groups)`, `batch_operator_minimum_active = operators_per_epoch * batch_op_groups` (cluster
    `batchOperatorCount = 3` ⇒ `3, 1, 3`). `epoch_duration_sec` **(cluster 90; production: real cadence)**.

21. `sysio.opreg::setconfig({...})` — `[sysio.opreg@active]`:

| Field | Value | Notes |
|---|---|---|
| `max_available_producers` | `21` | |
| `max_available_batch_ops` | `63` | |
| `max_available_underwriters` | `21` | still part of the `opreg` config; the bootstrap registers no underwriter operators |
| `terminate_prune_delay_ms` | `600000` | 10 min **(cluster; production: larger)** |
| `terminate_max_consecutive_misses` | `5` | |
| `terminate_max_pct_misses_24h` | `5` | |
| `terminate_window_ms` | `86400000` | 24 h |
| `req_prod_collat` | `[]` | per-(chain,token) min-bond rows; empty ⇒ no collateral required **(cluster; production: real minimums)** |
| `req_batchop_collat` | `[]` | empty by default |
| `req_uw_collat` | `[]` | empty by default |

22. **Genesis producer operators** — `sysio.opreg::regoperator({account:<producer>,
    type:OPERATOR_TYPE_PRODUCER, is_bootstrapped:true})` — `[sysio.opreg@active]` — one call per producer
    account (`defproducera … defproduceru`). Registered here rather than in Stage 5 because `sysio.opreg` is
    only deployed (Stage 8) and configured (step 21) by now. Bootstrapped by fiat: genesis producers post no
    collateral, `req_prod_collat` ships empty, and a non-bootstrapped registration against an empty
    requirement vector would never become eligible. As bootstrapped operators they are also exempt from
    `termcheck`.
23. **Genesis producer registration** — per producer account, in this order:
    - `sysio::regproducer({producer:<producer>, producer_key:<hosting node's K1>, url:"", location:0})` —
      `[<producer>@active]`. `sysio.system` admits it only for an ACTIVE PRODUCER operator, so it follows
      step 22. Registration is what makes a producer rankable: the ranked schedule is built only from
      producers with an active `producers` row.
    - `sysio::regfinkey({finalizer_name:<producer>, finalizer_key:<the account's own BLS pubkey>,
      proof_of_possession:<its BLS PoP>})` — `[<producer>@active]`. Requires the `producers` row written just
      above; a producer's first finalizer key is activated by `regfinkey` itself, so no `actfinkey` follows.
      The key is the same per-account BLS key the Stage 1 finalizer policy was built from.

    The producer, finalizer-key and finalizer rows are billed to `sysio.system`; producers receive no RAM
    grant for them. The bootstrap makes no producer collateral deposit.

24. **WIRE token + emissions** — `sysio.token` is reused for a separate `9,WIRE` token the emissions contract
    reads from `sysio`'s balance. Five actions, in order:
    - `sysio.token::create({issuer:"sysio", maximum_supply:"1000000000.000000000 WIRE"})` — `[sysio.token@active]`.
    - `sysio.token::issue({to:"sysio", quantity:"1000000000.000000000 WIRE", memo:"initial WIRE for emissions"})` — `[sysio@active]`.
    - `sysio::setemitcfg({cfg:{…}})` — `[sysio@active]` — full payload in the table below.
    - `sysio::setinittime({no_reward_init_time:"<Distribution Commencement Date, ISO-8601 YYYY-MM-DDTHH:MM:SS>"})` —
      `[sysio@active]` — seeds the `emissionmngr` singleton that anchors node-owner vesting. Every tier's schedule is
      measured from this one instant, so until it is set `claimnodedis` aborts with "emission state not initialized"
      and no node owner can claim — registration still succeeds, which is what makes the omission silent. Reads the
      emission config, so it must run after `setemitcfg`, and it is one-shot (a second call is rejected).
      **(cluster: the chain's `head_block_time`; production: the approved Distribution Commencement Date)**
    - `sysio::initt5({start_time:"<chain head time, ISO-8601 YYYY-MM-DDTHH:MM:SS>"})` — `[sysio@active]` — seeds
      the T5 state singleton (`start_time` = the chain's `head_block_time`, not wall clock). Must run after
      `setemitcfg` and before Stage 12's `bootstrap`.

    `sysio::setemitcfg` payload (WIRE amounts are 9-decimal subunits). The `tN_allocation` fields are **per node
    owner**, not per tier: `addnodeowner` copies the tier's value verbatim into that one owner's `nodedist` row, so
    a tier's total exposure is the value times its cap (21 / 84 / 1000). Across all three tiers that is
    341,500,000 WIRE against the 1,000,000,000 WIRE supply issued above.

| Field | Value | Meaning |
|---|---|---|
| `t1_allocation` | `7500000000000000` | 7,500,000 WIRE per T1 owner (× 21 cap = 157,500,000) |
| `t2_allocation` | `1000000000000000` | 1,000,000 WIRE per T2 owner (× 84 cap = 84,000,000) |
| `t3_allocation` | `100000000000000` | 100,000 WIRE per T3 owner (× 1000 cap = 100,000,000) |
| `t1_duration` | `31104000` | 12 × 30 d, seconds |
| `t2_duration` | `62208000` | 24 × 30 d |
| `t3_duration` | `93312000` | 36 × 30 d |
| `min_claimable` | `10000000000` | 10 WIRE |
| `t5_distributable` | `375000000000000000` | 375,000,000 WIRE (T5 treasury budget) |
| `t5_floor` | `125000000000000000` | 125,000,000 WIRE (T5 floor) |
| `target_annual_decay_bps` | `6940` | 69.40% annual survival (≈30.6% decay) |
| `annual_initial_emission` | `563150000000000 × 365 = 205549750000000000` | ≈563,150 WIRE/day, annualized |
| `annual_max_emission` | `3000000000000000 × 365 = 1095000000000000000` | 3,000,000 WIRE/day cap |
| `annual_min_emission` | `100000000000000 × 365 = 36500000000000000` | 100,000 WIRE/day floor |
| `compute_bps` | `4000` | 40% → producers + batch ops |
| `capex_bps` | `2000` | 20% → `sysio.ops` |
| `governance_bps` | `1000` | 10% → `sysio.gov` |
| *(implicit capital reserve)* | `3000` | `10000 − compute − capex − governance`; stays on `sysio`, drained by `fundclaim` |
| `producer_bps` | `7000` | compute split: 70% producers |
| `batch_op_bps` | `3000` | compute split: 30% batch ops |
| `standby_end_rank` | `28` | producers ranked ≤28 are standby-eligible |
| `standby_bps` | `800` | share of the producer pool reserved for the standby retainer (position-decaying); the rest is paid per block |
| `epoch_log_retention_count` | `8640` | emissions pay-log retention, in epochs |
| `pay_cadence_epochs` | `1` | fire `payepoch` every epoch **(cluster; production: higher)** |

25. `sysio.dclaim::setconfig({})` — `[sysio.dclaim@active]` — idempotent; creates the `cap_config` singleton
    with the contract's default 180-day claim window. (No `setclmwindow`/`importseed`/`importdone` in the
    bootstrap — those are external/operational tools, not part of the sequence.)

## Stage 10 — Register the bootstrap node owner (real `nodeownreg` flow; NO `forcereg`)
Drives the two `sysio.roa` actions the OPP NFT-claim depot (`sysio.msgch`) would inline-send for a real claim:

26. `sysio.roa::newnameduser({account:"wireno", pubkey:DEV_K1_PUBLIC_KEY, tier:1})` — `[sysio.roa@active]` —
    creates `wireno` (owner = active = `DEV_K1`) with a finite pool-gifted RAM allocation. `tier:1` = T1
    (Validator); `NodeOwnerTier` = `{T1:1, T2:2, T3:3}`.
27. `sysio.roa::nodeownreg({owner:"wireno", tier:1, eth_pub_key:<PUB_EM_…>, wire_pub_key:DEV_K1_PUBLIC_KEY, eth_address:<20-byte ETH address>})` —
    `[sysio.roa@active]` — records the depositor ETH key as a `sysio.authex` link (inline `recordlink`) and
    allocates the tier-1 reserve post-bootstrap resource policies are issued from. `eth_pub_key` is a **fresh
    random `PUB_EM_*` secp256k1 key (cluster throwaway; production: the NFT depositor's key)**; its
    corresponding `eth_address` is passed to the inline DClaim sweep. The key is recorded only, never
    signed with. Claim-payload problems SOFT-FAIL into a `nodeownerreg` audit row rather than
    aborting the transaction, so the tooling follows with a verify that the `nodeowners` row exists
    (surfacing the audit rejection if not).

## Stage 10b — Emergency stop (`sysio.andon`)
`setpanic` needs an existing account, so the panic account is created first, through the ordinary user path.

28. **Panic account** — `sysio::newaccount({creator:"sysio", name:"andon.panic", owner:DEV_K1_PUBLIC_KEY,
    active:DEV_K1_PUBLIC_KEY})` — `[sysio@active]` — then `sysio.roa::addpolicy({owner:"andon.panic",
    issuer:"wireno", net_weight:"25.0000 SYS", cpu_weight:"25.0000 SYS", ram_weight:"25.0000 SYS",
    time_block:0, network_gen:0})` — `[wireno@active]`. No WIRE is transferred to it **(cluster dev key;
    production: the governance-held panic key)**.
29. `sysio.andon::setpanic({account:"andon.panic"})` — `[sysio.andon@active]` — the account that may pull and
    clear the cord.
30. `sysio.andon::addpuller({contract:"sysio.synd"})` — `[sysio.andon@active]` — registers `sysio.synd` as a
    puller, so a custody shortfall it detects pulls the cord. The cord is armed before any cord reader carries
    traffic.

## Stage 11 — Outpost deploys, then registry + syndication configuration
The ETH and SOL outposts deploy here (chain-side, not depot actions): anvil starts (instamine), the Ethereum
outpost contracts deploy (`OPP`, `OPPInbound`, `OutpostManager`, `SyndicationPool`, `BAR`, the inert
`StakingManager`, plus the `liqEth` suite) and the tooling verifies the `SyndicationPool` configuration and
the panic account's pause role, then anvil switches to interval mining; solana-test-validator starts with all
four wire-solana programs at genesis (`liqsol_core` hosts the OPP outpost), the liqsol surface is stood up by
wire-solana's own `init-*` scripts, and the OPP PDAs are initialized with the native-SOL token binding and
precision. These deploys produce the artifact files (`outpost-addrs.json`, `liqeth-addrs.json`) the registry
rows below read their chain-side addresses from; in external-outpost mode the operator-supplied artifacts
(including `sol-mock-mints.json`) are copied into place instead. Production registers the canonical
contract/mint addresses via the same shapes.

31. **Chains** — `sysio.chains::regchain({kind, code, external_chain_id, name, description, outpost})` —
    `[sysio.chains@active]`, one per chain (registered ACTIVE; there is no separate `activchain`). `outpost`
    is left empty here and filled by `setoutpost` in Stage 12:

| `kind` | `code` | `external_chain_id` | `name` | `description` |
|---|---|---|---|---|
| `CHAIN_KIND_WIRE` | `slug("WIRE")` | `0` | `Wire (depot)` | the WIRE depot chain itself |
| `CHAIN_KIND_EVM` | `slug("ETHEREUM")` | `31337` **(cluster anvil; production: real EVM id)** | `Ethereum (anvil)` | local anvil EVM chain |
| `CHAIN_KIND_SVM` | `slug("SOLANA")` | `0` | `Solana (test-validator)` | local solana-test-validator |

32. **Tokens** — `sysio.tokens::regtoken({kind, code, symbol_name, description, precision, address})` —
    `[sysio.tokens@active]`, one per token (registered ACTIVE; no separate `activtoken`). `precision` is `9`
    for NATIVE/LIQ tokens and `6` for the ERC-20/SPL stablecoins (their chain-native decimals). `address =
    {kind, address}`; NATIVE leaves `address` empty; non-native carries the chain-side contract bytes (hex,
    `0x` stripped) when the deploy artifact provides them, and is empty otherwise:

| `kind` | `code` | `symbol_name` | `precision` | `address` source |
|---|---|---|---|---|
| `TOKEN_KIND_NATIVE` | `slug("WIRE")` | `Wire` | `9` | empty |
| `TOKEN_KIND_NATIVE` | `slug("ETH")` | `Ether` | `9` | empty |
| `TOKEN_KIND_LIQ` | `slug("LIQETH")` | `Liquid ETH` | `9` | deployed LiqETH EVM address **(runtime)** |
| `TOKEN_KIND_ERC20` | `slug("USDC")` | `USD Coin` | `6` | `MockUsdc` from `outpost-addrs.json` when present (the local deploy no longer ships one, so empty) |
| `TOKEN_KIND_ERC20` | `slug("USDT")` | `Tether USD` | `6` | `MockUsdt` from `outpost-addrs.json` when present (likewise empty locally) |
| `TOKEN_KIND_NATIVE` | `slug("SOL")` | `Sol` | `9` | empty |
| `TOKEN_KIND_LIQ` | `slug("LIQSOL")` | `Liquid SOL` | `9` | LIQSOL mint from `sol-mock-mints.json` when present |
| `TOKEN_KIND_SPL` | `slug("USDCSOL")` | `USDC (Solana)` | `6` | USDC mint from `sol-mock-mints.json` when present |
| `TOKEN_KIND_SPL` | `slug("USDTSOL")` | `USDT (Solana)` | `6` | USDT mint from `sol-mock-mints.json` when present |

33. **Chain-token bindings** — `sysio.tokens::regctok({chain_code, token_code, contract_addr, is_native})` —
    `[sysio.tokens@active]`, one per binding (no separate `activctok`). Exactly one `is_native:true` per chain;
    non-native bindings carry the same chain-side address bytes as their token row (empty when unavailable):
    `(WIRE,WIRE,native)`, `(ETHEREUM,ETH,native)`, `(ETHEREUM,LIQETH)`, `(ETHEREUM,USDC)`, `(ETHEREUM,USDT)`,
    `(SOLANA,SOL,native)`, `(SOLANA,LIQSOL)`, `(SOLANA,USDCSOL)`, `(SOLANA,USDTSOL)`.

34. `sysio.swap::setconfig({fee_authority:"sysio", system_token:{sym:"9,WIRE", contract:"sysio.token"}})` —
    `[sysio.swap@active]` — the depot-local AMM's fee authority and system token. `sysio.swap` trades on the
    depot only; it has no outpost participation and emits no OPP attestations.
35. **Shadow liq symbols** — `sysio.liq::create({sym, chain_code, token_code})` — `[sysio.liq@active]`, one per
    registered liq token: `{sym:"9,LIQETH", chain_code:slug("ETHEREUM"), token_code:slug("LIQETH")}` and
    `{sym:"9,LIQSOL", chain_code:slug("SOLANA"), token_code:slug("LIQSOL")}`. Syndicated outpost custody is
    minted 1:1 into these symbols.
36. `sysio.liq::setkicker({bps:200})` — `[sysio.liq@active]` — the T5 yield kicker.
37. **Underwriting + syndication rules:**
    - `sysio.bond::setconfig({hold_bps:1000})` — `[sysio.bond@active]` — the hold bond, in bps of a request's
      covered amount (the contract default, set explicitly).
    - `sysio.synd::setconfig({...})` — `[sysio.synd@active]`, one per shadow pair (`ETHEREUM/LIQETH`,
      `SOLANA/LIQSOL`). A pair with no row releases no syndication and accepts no desyndication:

| Field | Value | Notes |
|---|---|---|
| `synd_fee_bps` / `desynd_fee_bps` | `0` / `0` | **(cluster; production: real fees)** |
| `synd_burst` / `synd_refill` | `1000000000000000` / same | one million tokens at 9 decimals per bucket and per-epoch refill **(cluster)** |
| `desynd_burst` / `desynd_refill` | `1000000000000000` / same | likewise |
| `window_sec` | `60` | challenge window before `sysio.bond::approve` can succeed **(cluster; production: longer)** |
| `bounty` | `0` | bounty posted on each envelope's `sysio.bond` request |
| `challenge_extra` | `1000000000` | one token charged to a challenger on top of the hold bond (the contract refuses `0`) |

The tooling then verifies that every shadow symbol is at the depot frame's precision and that each
`(chain, token)` pair is an active `TOKEN_KIND_LIQ` token with an active binding (otherwise `sysio.msgch`
drops every `SYNDICATE_LIQ` of the pair).
38. **Mock data — opt-in only, never production.** Both run inside the epoch-0 window:
    - `--enable-mock-liq-pools`: `sysio.liq::regliqpool` × 2 — `[sysio.liq@active]` — a `LIQETHP` / `LIQSOLP`
      yield pool per shadow on `sysio.swap`, each seeded with `10000000000` shadow and `10000000000` WIRE base
      units, fee `30`, 30 s conversion horizon, 3000 bps depth cap, clip floor `1000`.
    - `--enable-mock-syndication-import`: `sysio.synd::importsynd` × 2 — one parked `100000000000` (100-token)
      position each of LIQSOL (ED key) and LIQETH (EM key) for an unlinked mock bonder — then
      `sysio.synd::importdone`, and a verify that both are parked with no custody mismatch.
    - With either flag, outpost custody is then funded (Solana pool ATA, Ethereum `SyndicationPool`) to back
      all outstanding mock shadow.

## Stage 12 — Operator provisioning + first epoch
The genesis-replacing real producer schedule is already live. NOTHING here uses `forcereg`.

39. `sysio.chains::setoutpost({code, outpost})` — `[sysio.chains@active]` — writes each outpost chain's remote
    addresses once the daemon artifacts are published: `ETHEREUM` gets `opp_addr` = `OPP` and
    `opp_inbound_addr` = `OPPInbound` (from `outpost-addrs.json`); `SOLANA` gets the `liqsol_core` program id
    in `opp_addr` alone (`sysio.chains` rejects an SVM row that fills the role-specific fields). Must precede
    any operator daemon start: a batch operator skips a chain whose addresses are unset.
40. **Operator accounts (node-owner-created)** — `sysio.roa::newuser({creator:"wireno", nonce:<label>,
    pubkey:<operator's generated K1>})` — `[wireno@active]` — one call per batch operator, labels
    `batchop.a/b/c` (3) **(cluster count)**. The tier-1 node owner sponsors each account: the chain
    generates a `wireno.<suffix>` account name (owner = active = the operator's K1), records the
    `(creator, nonce) → username` mapping in the `sponsors` table (sponsorship rows billed to `wireno`),
    and gifts `newaccount_ram` from the pool. The tooling adopts the generated name from the `sponsors`
    row keyed by its deterministic label/nonce. Each operator carries its OWN runtime-generated identity:
    a unique WIRE K1 (the account key, imported into the kiod wallet so `<account>@active` can sign), an
    ETH key (EM), and a SOL key (ED25519). No resource policy is issued to operators during bootstrap
    (`sysio.roa::addpolicy` is a post-bootstrap flow/user-provisioning tool).
    - SOL-side (not a depot action): each batch operator's ED keypair is airdropped **100 SOL** — its daemon
      pays the fees on every per-epoch `epoch_in` delivery. Anvil prefunds the operators' ETH HD accounts
      under `KEY`; under `SSM` (generated mnemonic) each is funded 10 ETH.
41. **Operator chain links** — `sysio.authex::createlink({chain_kind, account:<operator>, sig, pub_key,
    nonce})` — `[<operator>@active]` — per operator, one EVM link + one SVM link (signed by the operator's own
    active authority over a nonce'd message; **not** `recordlink`):
    - EVM (`chain_kind = CHAIN_KIND_EVM`, 2): `pub_key` = `PUB_EM_*` derived from the anvil mnemonic
      `"test test test test test test test test test test test junk"` at HD path `m/44'/60'/0'/0/<index>`,
      `index` = 1-based operator ordinal (batch ops 1–3). **(cluster; production: the operator's
      real ETH key.)**
    - SVM (`chain_kind = CHAIN_KIND_SVM`, 3): `pub_key` = the operator's generated ED25519 key (the same key
      its daemon's `--signature-provider` signs Solana txs with).
42. `sysio.opreg::regoperator({account:<operator>, type, is_bootstrapped})` — `[sysio.opreg@active]`:
    - batch operators: `type:OPERATOR_TYPE_BATCH`, `is_bootstrapped:true` (skip collateral; immediately
      AVAILABLE).

The OPP debugging server + daemon deploy artifacts (ETH ABIs with embedded addresses, SOL program id + IDL)
are prepared just before the provisioning above; the operator nodeop daemons start here — chain-side
infrastructure, before the first epoch.

43. `sysio.epoch::schbatchgps({})` — `[sysio.epoch@active]` — initialize batch-operator groups from the
    AVAILABLE (bootstrapped) batch ops. Local outposts are then seeded with that schedule before the first
    envelope (chain-side, not depot actions): Ethereum `OPPInbound.installInitialRoster` replaces the
    provisional roster, and Solana `opp_bootstrap` seeds the outpost's operator registry. External outposts
    are seeded by their own operators.
44. `sysio.msgch::bootstrap({})` — `[sysio.msgch@active]` — bootstrap the first epoch (index 0 → 1).

---

## Chain & node configuration (genesis + nodeop)
Not on-chain actions, but the remaining config the tooling sets so the picture is complete.

### `genesis.json` — `initial_configuration` (matches the Python launcher; CPU limits overridden to 400k/375k)
| Field | Value | Field | Value |
|---|---|---|---|
| `initial_key` | `DEV_K1_PUBLIC_KEY` | `min_transaction_cpu_usage` | `100` |
| `initial_finalizer_key` | `DEV_BLS_PUBLIC_KEY` | `max_transaction_lifetime` | `3600` |
| `max_block_net_usage` | `1048576` | `deferred_trx_expiration_window` | `600` |
| `target_block_net_usage_pct` | `10000` | `max_transaction_delay` | `3888000` |
| `max_transaction_net_usage` | `524288` | `max_inline_action_size` | `524287` |
| `net_usage_leeway` | `500` | `max_inline_action_depth` | `10` |
| `context_free_discount_net_usage_num/den` | `20 / 100` | `max_authority_depth` | `10` |
| `target_block_cpu_usage_pct` | `10` | `max_block_cpu_usage` | `400000` |
| `max_transaction_cpu_usage` | `375000` | | |

### nodeop arguments & topology
- Extra args (every node, every phase — the ini is read by both launch forms, so only phase-independent
  values live there): `vote-threads = 4`, `connection-cleanup-period = 15`, plus the topology-derived
  `max-clients` / `p2p-max-nodes-per-host` (the mesh size, not a fixed cap). HTTP is
  loosened for local tooling (`access-control-allow-origin/headers = *`, `verbose-http-errors = true`,
  `http-validate-host = false`), and dev clusters set
  `resource-monitor-not-shutdown-on-threshold-exceeded = true` (workstations routinely sit above the 90%
  disk threshold). API nodes carry the cluster-wide query-engine block (any set `read-mode` / `query-*`
  member of `ClusterConfig.queryEngine`) in their ini; nothing set means nodeop's and the plugin's own
  defaults.
- Deadlines are PHASE-SPLIT, and ride the nodeop argv rather than the ini (a CLI flag only wins when it is
  actually emitted, so an ini kv would resurrect a value the post-bootstrap form deliberately omits). The
  bootstrap spawn is permissive on every role — `max-transaction-time = -1`, `abi-serializer-max-time-ms =
  990000`, `http-max-response-time-ms = 990000` — because bootstrap pushes a dozen `setcode`s and a long tail
  of heavy setup through nodes that are also syncing. Post-bootstrap launches (`run`, and every emitted
  `start.sh`) drop `max-transaction-time` outright; only the non-public operator nodes (batch operators,
  whose HTTP surface serves their own co-located OPP daemon) retain the two `990000` timeouts —
  the public nodes (bios, producer, and API nodes) get neither, and nodeop's own defaults apply.
- Plugins — base: `net_plugin`, `chain_api_plugin`; producers add `producer_plugin`, `producer_api_plugin`;
  batch operators add `batch_operator_plugin`, `external_debugging_plugin`,
  `outpost_ethereum_client_plugin`, `outpost_solana_client_plugin`, `cron_plugin` (`underwriter_plugin` has
  been removed from wire-sysio). `trace_api_plugin` is CONDITIONAL: a LOCAL cluster keeps it on
  every role (the harness reads traces off `producer[0]`), while the production-shaped
  `create-external-config` tree drops it from the bios / producer nodes — operator nodes are non-public and
  retain it everywhere. API nodes: base + `query_engine_plugin`, plus `trace_api_plugin` in every deployment
  kind (they are the chain-read surface, like the standalone `create-api-node` artifact); never
  `producer_api_plugin`.
- Ports: every daemon default is a PREFERENCE — the bind resolver claims it only when free, otherwise an
  ephemeral free port (parallel-run safe; the resolved set persists in `cluster-config.json::bind`). Defaults
  live in `10500–11999`, above agave's reserved `8000–10000` band (a solana-test-validator binds implicit
  sockets there regardless of flags): bios nodeop HTTP `10788` / P2P `10776`; kiod `10890`; anvil `10545`;
  solana RPC `10899` (websocket = RPC+1; `10900` deliberately unassigned), faucet `10990`, gossip `11000`,
  `--dynamic-port-range` windows from `12000` (64 ports wide); debugging server `10991`. Producer and
  operator nodeop HTTP/P2P ports have NO fixed defaults — each pair is claimed dynamically at resolve time.

---

## Notes
- **Account creation order is RAM-driven:** only `sysio.roa`/`sysio.acct` are created before ROA (Stage 2);
  EVERY other account — producers included — is created after `system` + `activateroa` (Stage 5) so
  `system::native::newaccount` gifts its RAM from the pool (finite). Creating any account earlier (bios
  `newaccount`, pre-pool) would leave it unlimited, and `setsyscode`'s `giftram` rejects non-finite accounts.
- **Raw deploys:** `bios` then `system` (both on `sysio`), and `sysio.roa`. `system` is raw (not **sys**)
  because `setsyscode`'s `giftram` cannot self-target the `sysio` pool account.
- **Genesis vs. handoff keys:** genesis runs on `DEV_K1` (block signer) + `DEV_BLS` (finalizer) — the bios
  node. `setfinalizer` (Stage 1) switches finality to the producer accounts' own generated BLS keys (the
  keys each account later registers with `regfinkey`, step 23), and `setprodkeys` (Stage 5) switches
  production to the producer nodes' generated K1 keys — the same node K1s the producer accounts are keyed
  with and register with `regproducer`. Batch operators carry their own per-operator generated K1s.
  `DEV_K1` remains only as `sysio`'s active key and `wireno`'s key; production replaces all of these with
  real keys / msig.
- **`activateroa` sizing:** the bootstrap passes `total_sys = ROA_TOTAL_SYS = 75496.0000 SYS` and
  `bytes_per_unit = ROA_BYTES_PER_UNIT = 104` (both from `Constants.ts`). Per the asset-amount semantics in the
  RAM model above, that is `754,960,000 × 104` ≈ 78.5 GB of total RAM, not `75496 × 104`.
- **Registered ACTIVE, not activated:** `regchain`/`regtoken`/`regctok` seed their rows ACTIVE at
  bootstrap; there are no `activchain`/`activtoken`/`activctok`/activation actions in the sequence.
- **Execution-order vs. stage grouping:** the stages above follow the tooling's execution order
  (`ClusterBuildDefaults.compose`). Process bring-up interleaves around them: kiod, the wallet + generated
  node keys, and the bios + producer nodeop processes precede Stage 1; the ETH/SOL outpost deploys (Stage 11
  lead-in) run after node-owner registration and the emergency-stop arming (Stage 10b); the OPP debugging server + daemon artifacts are prepared just
  before Stage 12's provisioning; and the operator nodeop daemons start between `regoperator` and
  `schbatchgps`. The hard dependencies are
  unchanged: ROA active before any `setsyscode`; `setemitcfg` before `initt5` before `bootstrap`; the outpost
  deploy artifacts before the registry rows that embed their addresses.
