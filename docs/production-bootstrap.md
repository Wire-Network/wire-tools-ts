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
  amounts and lock windows, the external (ETH/SOL) chain ids, mock token contract addresses, reserve seed
  sizes, operator/producer counts. Production substitutes real keys, the real finalizer set, real external
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
  regenerated ABI emits. Chain/token/reserve codes are slug names.

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
  contracts (`sysio.token` plus the OPP set: chains, tokens, epoch, opreg, msgch, uwrit, reserv, chalg,
  dclaim) — are billed directly to `sysio` via a per-contract `ram_payer = "sysio"_n` (privileged-contract
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
  `[sysio.X@active]` step. Stage 8 only ADDs `@sysio.code` weights on the nine OPP accounts' **owner**
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
| Constant | Role | Value |
|---|---|---|
| `DEV_K1_PUBLIC_KEY` | Genesis `initial_key` (bios block-signing key); the standalone key on `sysio`'s own `active`; owner/active of node owner `wireno` — see note ¹. | `SYS6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV` |
| `DEV_K1_PRIVATE_KEY` | Matching WIF; imported into the `default` kiod wallet. | `5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFD3` |
| `DEV_BLS_PUBLIC_KEY` | Genesis `initial_finalizer_key` (bios finalizer); `BLS` from `SHA256("wire")`. | `PUB_BLS_3igm9y-m3poDQL9IU-oE2E3rjKVD025aN5_Kpod8aVKjqtg4xOrP-jGtz4wLg_IFzc7gay9YghYwVgNafpxphE2xOY5gzEPa8li1rmtFfdpXguDFhNw2FpuLWSWami8WXgUo3A` |
| `DEV_BLS_PROOF_OF_POSSESSION` | PoP for `DEV_BLS_PUBLIC_KEY`. | `SIG_BLS_qdQ36ASsBk_pJ9efSCZmSN5OcqNX7GIxjzpREX8TBOBVpUOheRfZmCGO7jay2lIZiD2vkrODGQDCsa3lfkB2FjhmoTce1TYpMOWv-PoPO4D36Y4yjItfa0iMgouirmcG_rubUJDtgn0bHdvtroCc3HDoBHVeI994Ycs62RVJEROyTjIlTVGk3iXoAK9skkQKz3DM3wT0yevxP_O47Ul85rJWnEVAlAjCUOsirAdu0yO1362pdnnl8kjXaPqEj_EYPvrRXw` |
| Per-node K1/BLS keys | Producer nodes' own block-signing (K1) + finalizer (BLS) keys, distinct from `DEV_*`; used by `setprodkeys` / `setfinalizer` AND as the producer accounts' owner/active keys. | generated at runtime (`clio create key --k1`, `sys-util bls create key`) |
| Per-operator K1/EM/ED keys | Each batch operator / underwriter's UNIQUE identity: a WIRE account key (K1, imported into kiod so `<operator>@active` signs), an ETH key (EM, anvil-mnemonic HD-derived), and a SOL key (ED25519). | generated at runtime (`KeyGenerator`) |
| `BOOTSTRAP_NODE_OWNER` | Bootstrap tier-1 node owner (2–6 chars to satisfy `valid_name_for_tier`); its tier-1 reserve is what post-bootstrap resource policies are issued from. | `wireno` |
| `DEFAULT_WALLET_NAME` | kiod wallet the bootstrap creates and every helper re-opens. | `default` |

¹ **`DEV_K1` derivation & governance scope.** `DEV_K1_PUBLIC_KEY` is `K1` regenerated from `SHA256("nathan")` (the well-known dev key, SYS-prefixed). It is the genesis block-signing key, the standalone key on `sysio`'s own `active`, and the owner/active key of node owner `wireno` — nothing else. Producer accounts are keyed by their **hosting node's generated K1**, operators (`batchop.*` / `uwrit.*`) by their **own per-operator generated K1**, and the `sysio.*` system accounts (and `dev.owner1`) by `sysio@active` — production substitutes real keys / msig throughout.

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
The bootstrap registers `wireno` (Stage 10) so its tier-1 reserve can issue these policies, but issues none
itself — flows/tools provision users and non-bootstrapped operators with them post-bootstrap:

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
| `batchOperatorCount` | `3` **(cluster)** | accounts `batchop.a/b/c` |
| `underwriterCount` | `1` **(cluster)** | account `uwrit.a` |
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
3. `sysio::setfinalizer({finalizer_policy:{threshold, finalizers:[…]}})` — `[sysio@active]`:
   - `threshold = floor(N*2/3) + 1`, where `N` = number of producer nodes (cluster default `N = 1` ⇒
     `threshold = 1`).
   - each finalizer `= {description:"finalizer-<nodeIndex>", weight:1, public_key:<that node's generated BLS
     pubkey>, pop:<that node's BLS proof-of-possession>}`. These are the **producer nodes' own generated BLS
     keys**, not `DEV_BLS` (which is only the genesis/bios finalizer).
   The chain finalizes on these node BLS keys and keeps producing on the genesis `sysio` producer until the
   Stage 5 handoff — no early `setprods`/`setprodkeys` (producer accounts don't exist pre-pool).

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
| OPP set | `sysio.chains`, `sysio.tokens`, `sysio.epoch`, `sysio.opreg`, `sysio.msgch`, `sysio.uwrit`, `sysio.reserv`, `sysio.chalg`, `sysio.dclaim` |
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
    `sysio.opreg`, `sysio.msgch`, `sysio.uwrit`, `sysio.reserv`, `sysio.chalg`, `sysio.dclaim`.
19. `sysio::updateauth` on **each OPP account's owner** (`grantSysioCode`) — `[<account>@owner]` — owner ←
    `{threshold:1, keys:[], accounts:[{sysio@active,1},{<account>@sysio.code,1}], waits:[]}` (sorted by name
    value; `sysio` sorts first). (9 calls.) Lets each contract inline-send its own actions (epoch `advance`,
    `evalcons`, `dispatch`, …) while staying governed by `sysio@active`.

These nine owner grants are the ONLY authority rewrites in the bootstrap. The former cross-contract
active-permission delegations (`@sysio.code` weights for `sysio.msgch` on opreg/roa and for `sysio.roa` on
authex) are no longer configured.

## Stage 9 — OPP / application configuration (epoch, opreg, emissions, dclaim)
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
| `max_available_underwriters` | `21` | |
| `terminate_prune_delay_ms` | `600000` | 10 min **(cluster; production: larger)** |
| `terminate_max_consecutive_misses` | `5` | |
| `terminate_max_pct_misses_24h` | `5` | |
| `terminate_window_ms` | `86400000` | 24 h |
| `req_prod_collat` | `[]` | per-(chain,token) min-bond rows; empty ⇒ no collateral required **(cluster; production: real minimums)** |
| `req_batchop_collat` | `[]` | empty by default |
| `req_uw_collat` | `[]` | empty by default |

22. **WIRE token + emissions** — `sysio.token` is reused for a separate `9,WIRE` token the emissions contract
    reads from `sysio`'s balance. Four actions, in order:
    - `sysio.token::create({issuer:"sysio", maximum_supply:"1000000000.000000000 WIRE"})` — `[sysio.token@active]`.
    - `sysio.token::issue({to:"sysio", quantity:"1000000000.000000000 WIRE", memo:"initial WIRE for emissions"})` — `[sysio@active]`.
    - `sysio::setemitcfg({cfg:{…}})` — `[sysio@active]` — full payload in the table below.
    - `sysio::initt5({start_time:"<chain head time, ISO-8601 YYYY-MM-DDTHH:MM:SS>"})` — `[sysio@active]` — seeds
      the T5 state singleton (`start_time` = the chain's `head_block_time`, not wall clock). Must run after
      `setemitcfg` and before Stage 12's `bootstrap`.

    `sysio::setemitcfg` payload (WIRE amounts are 9-decimal subunits):

| Field | Value | Meaning |
|---|---|---|
| `t1_allocation` | `7500000000000000` | 7,500,000 WIRE (T1 tier total) |
| `t2_allocation` | `15000000000000000` | 15,000,000 WIRE |
| `t3_allocation` | `30000000000000000` | 30,000,000 WIRE |
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
| `epoch_log_retention_count` | `8640` | emissions pay-log retention, in epochs |
| `pay_cadence_epochs` | `1` | fire `payepoch` every epoch **(cluster; production: higher)** |

23. `sysio.dclaim::setconfig({})` — `[sysio.dclaim@active]` — idempotent; creates the `cap_config` singleton
    with the contract's default 180-day claim window. (No `setclmwindow`/`importseed`/`importdone` in the
    bootstrap — those are external/operational tools, not part of the sequence.)

## Stage 10 — Register the bootstrap node owner (real `nodeownreg` flow; NO `forcereg`)
Drives the two `sysio.roa` actions the OPP NFT-claim depot (`sysio.msgch`) would inline-send for a real claim:

24. `sysio.roa::newnameduser({account:"wireno", pubkey:DEV_K1_PUBLIC_KEY, tier:1})` — `[sysio.roa@active]` —
    creates `wireno` (owner = active = `DEV_K1`) with a finite pool-gifted RAM allocation. `tier:1` = T1
    (Validator); `NodeOwnerTier` = `{T1:1, T2:2, T3:3}`.
25. `sysio.roa::nodeownreg({owner:"wireno", tier:1, eth_pub_key:<PUB_EM_…>, wire_pub_key:DEV_K1_PUBLIC_KEY})` —
    `[sysio.roa@active]` — records the depositor ETH key as a `sysio.authex` link (inline `recordlink`) and
    allocates the tier-1 reserve post-bootstrap resource policies are issued from. `eth_pub_key` is a **fresh
    random `PUB_EM_*` secp256k1 key (cluster throwaway; production: the NFT depositor's key)** — recorded
    only, never signed with. Claim-payload problems SOFT-FAIL into a `nodeownerreg` audit row rather than
    aborting the transaction, so the tooling follows with a verify that the `nodeowners` row exists
    (surfacing the audit rejection if not).

## Stage 11 — Outpost deploys, then registry seeding + underwriter config
The ETH and SOL outposts deploy here (chain-side, not depot actions): anvil starts (instamine), the Ethereum
outpost contracts deploy + seed, anvil switches to interval mining; solana-test-validator starts with
`liqsol_core` (the OPP outpost), then PDAs init + SPL reserves provision. These deploys produce the artifact
files (`outpost-addrs.json`, `liqeth-addrs.json`, `sol-mock-mints.json`) the registry rows below read their
chain-side addresses from; production registers the canonical contract/mint addresses via the same shapes.

26. **Chains** — `sysio.chains::regchain({kind, code, external_chain_id, name, description})` —
    `[sysio.chains@active]`, one per chain (registered ACTIVE; there is no separate `activchain`):

| `kind` | `code` | `external_chain_id` | `name` | `description` |
|---|---|---|---|---|
| `CHAIN_KIND_WIRE` | `slug("WIRE")` | `0` | `Wire (depot)` | the WIRE depot chain itself |
| `CHAIN_KIND_EVM` | `slug("ETHEREUM")` | `31337` **(cluster anvil; production: real EVM id)** | `Ethereum (anvil)` | local anvil EVM chain |
| `CHAIN_KIND_SVM` | `slug("SOLANA")` | `0` | `Solana (test-validator)` | local solana-test-validator |

27. **Tokens** — `sysio.tokens::regtoken({kind, code, symbol_name, description, precision, address})` —
    `[sysio.tokens@active]`, one per token (registered ACTIVE; no separate `activtoken`). `precision` is `9`
    for NATIVE/LIQ tokens and `6` for the ERC-20/SPL stablecoins (their chain-native decimals). `address =
    {kind, address}`; NATIVE leaves `address` empty; non-native carries the chain-side contract bytes (hex,
    `0x` stripped):

| `kind` | `code` | `symbol_name` | `precision` | `address` source |
|---|---|---|---|---|
| `TOKEN_KIND_NATIVE` | `slug("WIRE")` | `Wire` | `9` | empty |
| `TOKEN_KIND_NATIVE` | `slug("ETH")` | `Ether` | `9` | empty |
| `TOKEN_KIND_LIQ` | `slug("LIQETH")` | `Liquid ETH` | `9` | deployed LiqETH EVM address **(runtime)** |
| `TOKEN_KIND_ERC20` | `slug("USDC")` | `USD Coin` | `6` | mock USDC EVM address **(runtime)** |
| `TOKEN_KIND_ERC20` | `slug("USDT")` | `Tether USD` | `6` | mock USDT EVM address **(runtime)** |
| `TOKEN_KIND_NATIVE` | `slug("SOL")` | `Sol` | `9` | empty |
| `TOKEN_KIND_LIQ` | `slug("LIQSOL")` | `Liquid SOL` | `9` | mock LIQSOL SPL mint **(runtime)** |
| `TOKEN_KIND_SPL` | `slug("USDCSOL")` | `USDC (Solana)` | `6` | mock USDC SPL mint **(runtime)** |
| `TOKEN_KIND_SPL` | `slug("USDTSOL")` | `USDT (Solana)` | `6` | mock USDT SPL mint **(runtime)** |

28. **Chain-token bindings** — `sysio.tokens::regctok({chain_code, token_code, contract_addr, is_native})` —
    `[sysio.tokens@active]`, one per binding (no separate `activctok`). Exactly one `is_native:true` per chain;
    non-native bindings carry the same chain-side address bytes as their token row (empty when unavailable):
    `(WIRE,WIRE,native)`, `(ETHEREUM,ETH,native)`, `(ETHEREUM,LIQETH)`, `(ETHEREUM,USDC)`, `(ETHEREUM,USDT)`,
    `(SOLANA,SOL,native)`, `(SOLANA,LIQSOL)`, `(SOLANA,USDCSOL)`, `(SOLANA,USDTSOL)`.

29. **Reserves** — `sysio.reserv::regreserve({chain_code, token_code, reserve_code:slug("PRIMARY"), name,
    description, initial_chain_amount, initial_wire_amount:10000000000, source_token_precision,
    connector_weight_bps:5000, is_private:false, owner:""})` — `[sysio.reserv@active]`, one PRIMARY reserve
    per external chain-token (registered ACTIVE). Eight reserves: `ETHEREUM×{ETH, LIQETH, USDC, USDT}` and
    `SOLANA×{SOL, LIQSOL, USDCSOL, USDTSOL}`. Every reserve seeds a 10-token notional on each leg **(cluster
    devnet sizing; production: real seeds)**, 50% Bancor connector weight, public, no owner. The depot frames
    each chain leg at `min(native, 9)` decimals, recorded per-reserve as `source_token_precision`:
    - non-stable rows: `initial_chain_amount = 10,000,000,000` (9-dec frame), `source_token_precision = 9`;
    - stablecoin rows (`USDC`/`USDT`/`USDCSOL`/`USDTSOL`): `initial_chain_amount = 10,000,000` (the same 10
      tokens in their 6-dec native frame), `source_token_precision = 6`.

30. `sysio.uwrit::setconfig({fee_bps:30, collateral_lock_duration_ms:600000, min_fromwire_amount:100000000,
    fromwire_revert_fee_bps:10})` — `[sysio.uwrit@active]`:
    - `fee_bps = 30` — the per-spoke swap fee, taken out of the WIRE leg of every swap; `sysio.reserv` routes
      the collected fee 50/50 to its rewards bucket and the `sysio` emissions treasury
      (`FEE_REWARD_SHARE_BPS`) **(cluster 30; the contract default is 10)**.
    - `collateral_lock_duration_ms = 600000` — the **wall-clock** challenge window: locks are never released
      by delivery; they expire this many ms after creation and are swept by `chklocks` at epoch advance
      **(cluster 10 min; the contract default is 12 h = 43,200,000 ms — production uses that)**.
    - `min_fromwire_amount = 100000000` — minimum `swapfromwire` escrow (9-dec base units) = 0.1 WIRE
      **(cluster, matching the flow's escrow exactly; the contract default is 5 WIRE = 5,000,000,000)**.
    - `fromwire_revert_fee_bps = 10` — fee on caller-fault drain-time reverts of queued `swapfromwire` rows
      (zero quote / missed variance at `drainfwq`), routed like the settlement fee (mirrors the contract
      default; happy-path flows never pay it and system-caused reverts refund in full).

## Stage 12 — Operator provisioning + first epoch
The genesis-replacing real producer schedule is already live. NOTHING here uses `forcereg`.

31. **Operator accounts** — `sysio::newaccount({creator:"sysio", name, owner:<operator's generated K1>,
    active:<same K1>})` — `[sysio@active]` — `batchop.a/b/c` (3) + `uwrit.a` (1) **(cluster counts)**. Each
    operator carries its OWN runtime-generated identity: a unique WIRE K1 (the account key, imported into the
    kiod wallet so `<operator>@active` can sign), an ETH key (EM), and a SOL key (ED25519). No resource
    policy is issued during bootstrap (`sysio.roa::addpolicy` is a post-bootstrap flow/user-provisioning
    tool). **(cluster: `sysio` creates the operator accounts directly; target design: operator accounts are
    created/sponsored by a node owner — pending harness/flow update.)**
    - SOL-side (not a depot action): each batch operator's ED keypair is airdropped **100 SOL** — its daemon
      pays the fees on every per-epoch `epoch_in` delivery. Underwriters get no airdrop; anvil prefunds the
      operators' ETH HD accounts.
32. **Operator chain links** — `sysio.authex::createlink({chain_kind, account:<operator>, sig, pub_key,
    nonce})` — `[<operator>@active]` — per operator, one EVM link + one SVM link (signed by the operator's own
    active authority over a nonce'd message; **not** `recordlink`):
    - EVM (`chain_kind = CHAIN_KIND_EVM`, 2): `pub_key` = `PUB_EM_*` derived from the anvil mnemonic
      `"test test test test test test test test test test test junk"` at HD path `m/44'/60'/0'/0/<index>`,
      `index` = 1-based operator ordinal (batch ops 1–3, underwriter 4). **(cluster; production: the operator's
      real ETH key.)**
    - SVM (`chain_kind = CHAIN_KIND_SVM`, 3): `pub_key` = the operator's generated ED25519 key (the same key
      its daemon's `--signature-provider` signs Solana txs with).
33. `sysio.opreg::regoperator({account:<operator>, type, is_bootstrapped})` — `[sysio.opreg@active]`:
    - batch operators: `type:OPERATOR_TYPE_BATCH`, `is_bootstrapped:true` (skip collateral; immediately
      AVAILABLE).
    - underwriters: `type:OPERATOR_TYPE_UNDERWRITER`, `is_bootstrapped:false` (deposit flow path).

The OPP debugging server + daemon deploy artifacts (ETH ABIs with embedded addresses, SOL program id + IDL)
are prepared just before the provisioning above; the operator nodeop daemons start here — chain-side
infrastructure, before the first epoch.

34. `sysio.epoch::schbatchgps({})` — `[sysio.epoch@active]` — initialize batch-operator groups from the
    AVAILABLE (bootstrapped) batch ops.
35. `sysio.msgch::bootstrap({})` — `[sysio.msgch@active]` — bootstrap the first epoch (index 0 → 1).

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
- Extra args (every node): `vote-threads = 4`, `max-transaction-time = -1`, `abi-serializer-max-time-ms =
  990000`, `max-clients = 25`, `connection-cleanup-period = 15`, `http-max-response-time-ms = 990000`. HTTP is
  loosened for local tooling (`access-control-allow-origin/headers = *`, `verbose-http-errors = true`,
  `http-validate-host = false`), and dev clusters set
  `resource-monitor-not-shutdown-on-threshold-exceeded = true` (workstations routinely sit above the 90%
  disk threshold).
- Plugins — base: `net_plugin`, `chain_api_plugin`; producers add `producer_plugin`, `producer_api_plugin`,
  `trace_api_plugin`; batch operators add `batch_operator_plugin`, `external_debugging_plugin`,
  `outpost_ethereum_client_plugin`, `outpost_solana_client_plugin`, `cron_plugin`; underwriters add
  `underwriter_plugin`, `outpost_ethereum_client_plugin`, `outpost_solana_client_plugin`,
  `external_debugging_plugin`, `cron_plugin`.
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
  node. `setfinalizer` (Stage 1) switches finality to the producer nodes' generated BLS keys, and
  `setprodkeys` (Stage 5) switches production to their generated K1 keys — the same node K1s the producer
  accounts are keyed with. Batch operators / underwriters carry their own per-operator generated K1s.
  `DEV_K1` remains only as `sysio`'s active key and `wireno`'s key; production replaces all of these with
  real keys / msig.
- **`activateroa` sizing:** the bootstrap passes `total_sys = ROA_TOTAL_SYS = 75496.0000 SYS` and
  `bytes_per_unit = ROA_BYTES_PER_UNIT = 104` (both from `Constants.ts`). Per the asset-amount semantics in the
  RAM model above, that is `754,960,000 × 104` ≈ 78.5 GB of total RAM, not `75496 × 104`.
- **Registered ACTIVE, not activated:** `regchain`/`regtoken`/`regctok`/`regreserve` seed their rows ACTIVE at
  bootstrap; there are no `activchain`/`activtoken`/`activctok`/activation actions in the sequence.
- **Execution-order vs. stage grouping:** the stages above follow the tooling's execution order
  (`ClusterBuildDefaults.compose`). Process bring-up interleaves around them: kiod, the wallet + generated
  node keys, and the bios + producer nodeop processes precede Stage 1; the ETH/SOL outpost deploys (Stage 11
  lead-in) run after node-owner registration; the OPP debugging server + daemon artifacts are prepared just
  before Stage 12's provisioning; and the operator nodeop daemons start between `regoperator` and
  `schbatchgps`. The hard dependencies are
  unchanged: ROA active before any `setsyscode`; `setemitcfg` before `initt5` before `bootstrap`; the outpost
  deploy artifacts before the registry rows that embed their addresses.
