# Wire production bootstrap sequence

Canonical, ordered list of on-chain actions to bootstrap a Wire chain, with **every** value each action
passes specified inline. The cluster tooling (`wire-tools-ts`,
`packages/test-cluster-tool/src/cluster/ClusterManager.ts` + `constants.ts`) is the source of truth for the
concrete values shown here; this document is meant to be read **stand-alone** — no value requires opening
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
  code/abi bytes from the pool. `giftram` SKIPS unlimited accounts, so the account must already be finite.
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
  `[sysio.X@active]` step. Stage 7–8 only ADD `@sysio.code` weights on top of that `sysio@active` base (never
  remove it).
- The root **`sysio`** account is the one exception: its own `active` authority carries a **standalone key**
  (cluster: `DEV_K1`; production: the governance key / msig), plus the `sysio.authex@sysio.code` weight added
  in Stage 7. It is never a `sysio@active` self-reference.
- All system contracts are privileged: `sysio`/`bios`/`system` from genesis; the **sys**-deployed set via
  `setsyscode`. Hard requirements (from source): `sysio.token` (bills rows to `sysio`), `sysio.msig`,
  `sysio.wrap` (both `act.send()` arbitrary-auth actions).

---

## Reference constants & identities
Single source of truth for the cross-cutting scalars; the stages reference these by name.

### Keys & identities (cluster dev keys — production substitutes real keys / msig)
| Constant | Value | Derivation / role |
|---|---|---|
| `DEV_K1_PUBLIC_KEY` | `SYS6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV` | `K1` regenerated from `SHA256("nathan")` (the well-known dev key, SYS-prefixed). Genesis `initial_key`; owner/active of every cluster-created account. |
| `DEV_K1_PRIVATE_KEY` | `5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFD3` | Matching WIF. Imported into the `default` kiod wallet. |
| `DEV_BLS_PUBLIC_KEY` | `PUB_BLS_3igm9y-m3poDQL9IU-oE2E3rjKVD025aN5_Kpod8aVKjqtg4xOrP-jGtz4wLg_IFzc7gay9YghYwVgNafpxphE2xOY5gzEPa8li1rmtFfdpXguDFhNw2FpuLWSWami8WXgUo3A` | `BLS` regenerated from `SHA256("wire")`. Genesis `initial_finalizer_key` (bios finalizer). |
| `DEV_BLS_PROOF_OF_POSSESSION` | `SIG_BLS_qdQ36ASsBk_pJ9efSCZmSN5OcqNX7GIxjzpREX8TBOBVpUOheRfZmCGO7jay2lIZiD2vkrODGQDCsa3lfkB2FjhmoTce1TYpMOWv-PoPO4D36Y4yjItfa0iMgouirmcG_rubUJDtgn0bHdvtroCc3HDoBHVeI994Ycs62RVJEROyTjIlTVGk3iXoAK9skkQKz3DM3wT0yevxP_O47Ul85rJWnEVAlAjCUOsirAdu0yO1362pdnnl8kjXaPqEj_EYPvrRXw` | PoP for `DEV_BLS_PUBLIC_KEY`. |
| Per-node K1/BLS keys | generated at runtime (`clio create key --k1`, `sys-util bls create key`) | The **producer nodes'** own block-signing (K1) and finalizer (BLS) keys — distinct from `DEV_*`. Used by `setprodkeys` and `setfinalizer`. |
| `BOOTSTRAP_NODE_OWNER` | `wireno` | Bootstrap tier-1 node owner (2–6 chars to satisfy `valid_name_for_tier`). Issues every operator ROA policy. |
| `DEFAULT_WALLET_NAME` | `default` | kiod wallet name the bootstrap creates and every helper re-opens. |

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

### Resource-policy weights (`sysio.roa::addpolicy`, per operator/account)
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
| `epochDurationSec` | `360` **(cluster; production: real cadence)** | |
| `EnvelopeLogRetentionEpochs` | `128` | `sysio.epoch::setconfig.epoch_retention_envelope_log_count` |

---

## Stage 1 — Core chain bring-up (bios on `sysio`, raw)
1. deploy `bios` → `sysio` — **raw** — `[sysio@active]` — `setcode`/`setabi(sysio, bios.wasm/abi)`.
2. `sysio::activate(feature_digest)` — `[sysio@active]` — for **every** digest returned by the bios node's
   `GET /v1/producer/get_supported_protocol_features`, **except** `PREACTIVATE_FEATURE`. `PREACTIVATE_FEATURE`
   is not activated by this action — it is activated out-of-band by the producer node (the standard
   `schedule_protocol_feature_activations` producer-API step) so that the `bios` `activate` action works for
   every other feature. "already activated" errors are benign and ignored.
3. `sysio::setfinalizer({finalizer_policy:{threshold, finalizers:[…]}})` — `[sysio@active]`:
   - `threshold = floor(N*2/3) + 1`, where `N` = number of producer nodes (cluster default `N = 1` ⇒
     `threshold = 1`).
   - each finalizer `= {description:"finalizer-<nodeId>", weight:1, public_key:<that node's generated BLS
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
   (Stage 9).

## Stage 5 — Create ALL remaining accounts (pool-gifted, finite) + producer handoff
Every account here is created via `system::native::newaccount`, which gifts `newaccount_ram` from the `sysio`
pool (`set_resource_limits(new,0,0,0)` + `transfer_ram(sysio,new,newaccount_ram)`) — each is FINITE, never
unlimited.
9. **Producer accounts** — `sysio::newaccount({creator:"sysio", name, owner:DEV_K1_PUBLIC_KEY,
   active:DEV_K1_PUBLIC_KEY})` × 21 — `[sysio@active]` — names `defproducera … defproduceru`. Producers carry
   their own account key (cluster: `DEV_K1`; production: the producer's real key); their RAM is pool-gifted
   like everything else.
10. **Remaining `sysio.*` accounts** — `sysio::newaccount({creator:"sysio", name, owner:sysio@active,
    active:sysio@active})` — `[sysio@active]` — every entry of the system-account set except `sysio.roa` /
    `sysio.acct` (created in Stage 2):
    `sysio.noop`, `sysio.bpay`, `sysio.msig`, `sysio.names`, `sysio.token`, `sysio.vpay`, `sysio.wrap`,
    `sysio.authex`, `sysio.chains`, `sysio.tokens`, `sysio.epoch`, `sysio.opreg`, `sysio.msgch`, `sysio.uwrit`,
    `sysio.reserv`, `sysio.chalg`, `sysio.dclaim`, `sysio.gov` (T5 governance bucket), `sysio.ops` (T5
    capex/ops bucket), and `dev.owner1` **(cluster-only dev account)**.
11. `sysio::setprodkeys({schedule:[{producer_name, block_signing_key}…]})` — `[sysio@active]` — one row per
    producer; `block_signing_key` = the **generated K1 pubkey of the node hosting that producer** (cluster
    single-node: all 21 map to that one node's key). Then poll `get_info` until `head_block_producer != "sysio"`
    (handoff; 90 s timeout) — the genesis `sysio` producer hands off to the real schedule.

## Stage 6 — Token contract + SYS supply (sysio.token via sys deploy)
12. deploy `sysio.token` — **sys** — `[sysio@active]`.
13. `sysio.token::create({issuer:"sysio", maximum_supply:"1000000000.0000 SYS"})` — `[sysio.token@active]`.
14. `sysio.token::issue({to:"sysio", quantity:"1000000000.0000 SYS", memo:"initial issue"})` — `[sysio@active]`.
15. `sysio.token::transfer({from:"sysio", to:<producer>, quantity:"1000000.0000 SYS", memo:"init"})` × 21
    producers — `[sysio@active]`.

## Stage 7 — `sysio.authex` + `sysio.code` on root, then msig/wrap, then init
16. deploy `sysio.authex` — **sys** — `[sysio@active]`.
17. `sysio::updateauth` on **`sysio.authex` owner** (`grantSysioCode`) — `[sysio.authex@owner]` — sets owner to
    `{threshold:1, keys:[], accounts:[{sysio@active,1},{sysio.authex@sysio.code,1}], waits:[]}` (sorted; `sysio`
    sorts first).
18. `sysio::updateauth` on **`sysio` active** — `[sysio@active]` — sets `sysio.active` to
    `{threshold:1, keys:[{DEV_K1_PUBLIC_KEY,1}], accounts:[{sysio.authex@sysio.code,1}], waits:[]}`
    (parent `owner`). **(cluster key; production: governance key / msig.)**
19. deploy `sysio.msig`, then `sysio.wrap` — **sys** — `[sysio@active]` — no `sysio.code` grant needed
    (`setsyscode` already deploys them privileged).
20. `sysio::init({version:0, core:"4,SYS"})` — `[sysio@active]`.

## Stage 8 — OPP contracts + cross-contract `sysio.code` delegations
21. deploy the OPP set — **sys** — `[sysio@active]`, in order: `sysio.chains`, `sysio.tokens`, `sysio.epoch`,
    `sysio.opreg`, `sysio.msgch`, `sysio.uwrit`, `sysio.reserv`, `sysio.chalg`, `sysio.dclaim`.
22. `sysio::updateauth` on **each OPP account's owner** (`grantSysioCode`) — `[<account>@owner]` — owner ←
    `{threshold:1, keys:[], accounts:[{sysio@active,1},{<account>@sysio.code,1}], waits:[]}`. (9 calls.)
23. `sysio::updateauth` on **`sysio.opreg` active** — `[sysio.opreg@owner]` — active ←
    `{sysio@active, sysio.msgch@sysio.code, sysio.opreg@sysio.code}` (threshold 1, sorted, no key). Lets
    `sysio.msgch` inline-send `opreg::deposit`/`queuewtdw`.
24. `sysio::updateauth` on **`sysio.roa` active** — `[sysio.roa@owner]` — active ←
    `{sysio@active, sysio.msgch@sysio.code, sysio.roa@sysio.code}`. Lets `sysio.msgch` drive the node-owner
    claim (`roa::newnameduser`/`nodeownreg`) inline; `sysio.roa@sysio.code` keeps roa's own inline `newaccount`
    authorized.
25. `sysio::updateauth` on **`sysio.authex` active** — `[sysio.authex@owner]` — active ←
    `{sysio@active, sysio.authex@sysio.code, sysio.roa@sysio.code}`. Lets `sysio.roa::nodeownreg` inline-send
    `authex::recordlink`.

## Stage 9 — Register the bootstrap node owner (real `nodeownreg` flow; NO `forcereg`)
Drives the two `sysio.roa` actions the OPP NFT-claim depot (`sysio.msgch`) would inline-send for a real claim:
26. `sysio.roa::newnameduser({account:"wireno", pubkey:DEV_K1_PUBLIC_KEY, tier:1})` — `[sysio.roa@active]` —
    creates `wireno` (owner = active = `DEV_K1`) with a finite pool-gifted RAM allocation. `tier:1` = T1
    (Validator); `NodeOwnerTier` = `{T1:1, T2:2, T3:3}`.
27. `sysio.roa::nodeownreg({owner:"wireno", tier:1, eth_pub_key:<PUB_EM_…>, wire_pub_key:DEV_K1_PUBLIC_KEY})` —
    `[sysio.roa@active]` — records the depositor ETH key as a `sysio.authex` link (inline `recordlink`) and
    allocates the tier-1 reserve `wireno` issues operator policies from. `eth_pub_key` is a **fresh random
    `PUB_EM_*` secp256k1 key (cluster throwaway; production: the NFT depositor's key)** — recorded only, never
    signed with.

## Stage 10 — OPP / application configuration
28. `sysio.epoch::setconfig({epoch_duration_sec:360, operators_per_epoch:1,
    batch_operator_minimum_active:3, batch_op_groups:3, epoch_retention_envelope_log_count:128})` —
    `[sysio.epoch@active]`. Sizing is computed from the operator counts:
    `batch_op_groups = min(3, batchOperatorCount)`, `operators_per_epoch = ceil(batchOperatorCount /
    batch_op_groups)`, `batch_operator_minimum_active = operators_per_epoch * batch_op_groups` (cluster
    `batchOperatorCount = 3` ⇒ `3, 1, 3`). `epoch_duration_sec` **(cluster 360; production: real cadence)**.

29. `sysio.opreg::setconfig({...})` — `[sysio.opreg@active]`:
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

30. **WIRE token + emissions** — `sysio.token` is reused for a separate `9,WIRE` token the emissions contract
    reads from `sysio`'s balance:
    - `sysio.token::create({issuer:"sysio", maximum_supply:"1000000000.000000000 WIRE"})` —
      `[sysio.token@active]`.
    - `sysio.token::issue({to:"sysio", quantity:"1000000000.000000000 WIRE", memo:"initial WIRE for emissions"})`
      — `[sysio@active]`.
    - `sysio::setemitcfg({cfg:{…}})` — `[sysio@active]` — full payload (WIRE amounts are 9-decimal subunits):
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
      | `epoch_log_retention_count` | `8640` | emissions pay-log retention (≈30 d at 360 s/epoch) |
      | `pay_cadence_epochs` | `1` | fire `payepoch` every epoch **(cluster; production: higher)** |
    - `sysio::initt5({start_time:"<chain head time, ISO-8601 YYYY-MM-DDTHH:MM:SS>"})` — `[sysio@active]` — seeds
      the T5 state singleton (`start_time` = the chain's `head_block_time`, not wall clock). Must run after
      `setemitcfg` and before Stage 11's `bootstrap`.

31. `sysio.dclaim::setconfig({})` — `[sysio.dclaim@active]` — idempotent; creates the `cap_config` singleton
    with the contract's default 180-day claim window. (No `setclmwindow`/`importseed`/`importdone` in the
    bootstrap — those are external/operational tools, not part of the sequence.)

32. **Chains** — `sysio.chains::regchain({kind, code, external_chain_id, name, description})` —
    `[sysio.chains@active]`, one per chain (registered ACTIVE; there is no separate `activchain`):
    | `kind` | `code` | `external_chain_id` | `name` | `description` |
    |---|---|---|---|---|
    | `CHAIN_KIND_WIRE` | `slug("WIRE")` | `0` | `Wire (depot)` | the WIRE depot chain itself |
    | `CHAIN_KIND_EVM` | `slug("ETHEREUM")` | `31337` **(cluster anvil; production: real EVM id)** | `Ethereum (anvil)` | local anvil EVM chain |
    | `CHAIN_KIND_SVM` | `slug("SOLANA")` | `0` | `Solana (test-validator)` | local solana-test-validator |

33. **Tokens** — `sysio.tokens::regtoken({kind, code, symbol_name, description, precision, address})` —
    `[sysio.tokens@active]`, one per token (registered ACTIVE; no separate `activtoken`). **`precision = 9`
    for every token** (project rule). `address = {kind, address}`; NATIVE leaves `address` empty; non-native
    carries the chain-side contract bytes (hex, `0x` stripped):
    | `kind` | `code` | `symbol_name` | `address` source |
    |---|---|---|---|
    | `TOKEN_KIND_NATIVE` | `slug("WIRE")` | `Wire` | empty |
    | `TOKEN_KIND_NATIVE` | `slug("ETH")` | `Ether` | empty |
    | `TOKEN_KIND_LIQ` | `slug("LIQETH")` | `Liquid ETH` | deployed LiqETH EVM address **(runtime)** |
    | `TOKEN_KIND_ERC20` | `slug("USDC")` | `USD Coin` | mock USDC EVM address **(runtime)** |
    | `TOKEN_KIND_ERC20` | `slug("USDT")` | `Tether USD` | mock USDT EVM address **(runtime)** |
    | `TOKEN_KIND_NATIVE` | `slug("SOL")` | `Sol` | empty |
    | `TOKEN_KIND_LIQ` | `slug("LIQSOL")` | `Liquid SOL` | mock LIQSOL SPL mint **(runtime)** |
    | `TOKEN_KIND_SPL` | `slug("USDCSOL")` | `USDC (Solana)` | mock USDC SPL mint **(runtime)** |
    | `TOKEN_KIND_SPL` | `slug("USDTSOL")` | `USDT (Solana)` | mock USDT SPL mint **(runtime)** |
    Chain-side addresses are deployed by the ETH/SOL bootstrap (anvil / solana-test-validator); production
    registers the canonical contract/mint addresses via the same shape.

34. **Chain-token bindings** — `sysio.tokens::regctok({chain_code, token_code, contract_addr, is_native})` —
    `[sysio.tokens@active]`, one per binding (no separate `activctok`). Exactly one `is_native:true` per chain;
    non-native bindings carry the same chain-side address bytes as their token row (empty when unavailable):
    `(WIRE,WIRE,native)`, `(ETHEREUM,ETH,native)`, `(ETHEREUM,LIQETH)`, `(ETHEREUM,USDC)`, `(ETHEREUM,USDT)`,
    `(SOLANA,SOL,native)`, `(SOLANA,LIQSOL)`, `(SOLANA,USDCSOL)`, `(SOLANA,USDTSOL)`.

35. **Reserves** — `sysio.reserv::regreserve({chain_code, token_code, reserve_code:slug("PRIMARY"), name,
    description, initial_chain_amount:10000000000, initial_wire_amount:10000000000, connector_weight_bps:5000,
    is_private:false, owner:""})` — `[sysio.reserv@active]`, one PRIMARY reserve per external chain-token
    (registered ACTIVE). Shared params: `10,000,000,000` units on both the chain and WIRE legs **(cluster
    devnet sizing; production: real seeds)**, 50% Bancor connector weight, public, no owner. Eight reserves:
    `ETHEREUM×{ETH, LIQETH, USDC, USDT}` and `SOLANA×{SOL, LIQSOL, USDCSOL, USDTSOL}`.

36. `sysio.uwrit::setconfig({fee_bps:10, collateral_lock_duration_ms:600000, fee_split_winner_pct:50,
    fee_split_other_uw_pct:25, fee_split_batch_op_pct:25})` — `[sysio.uwrit@active]`:
    - `fee_bps = 10` — the WIRE-leg swap fee (single source of truth; the swap flows import the same value).
    - `collateral_lock_duration_ms = 600000` — a **wall-clock** lock window of 10 min **(cluster; the contract
      default is 12 h = 43,200,000 ms — production uses that)**.
    - `fee_split_winner_pct:50 / fee_split_other_uw_pct:25 / fee_split_batch_op_pct:25` — legacy split fields,
      being removed (the WIRE-leg fee is split rewards/emissions by a fixed share); clio ignores extra JSON
      fields, so sending them is a harmless no-op until the ABI regen drops them.

## Stage 11 — Operator provisioning + first epoch
Performed against the registered node owner `wireno`; the genesis-replacing real producer schedule is already
live. NOTHING here uses `forcereg`.
37. **Operator accounts** — `sysio::newaccount({creator:"sysio", name, owner:DEV_K1_PUBLIC_KEY,
    active:DEV_K1_PUBLIC_KEY})` — `[sysio@active]` — `batchop.a/b/c` (3) + `uwrit.a` (1) **(cluster counts)**.
    Then `sysio.roa::addpolicy({owner:<operator>, issuer:"wireno", net_weight:"25.0000 SYS",
    ram_weight:"25.0000 SYS", cpu_weight:"25.0000 SYS", time_block:0, network_gen:0})` — `[wireno@active]` —
    finite RAM from `wireno`'s tier-1 reserve.
38. `sysio.opreg::regoperator({account:<operator>, type, is_bootstrapped})` — `[sysio.opreg@active]`:
    - batch operators: `type:OPERATOR_TYPE_BATCH`, `is_bootstrapped:true` (skip collateral; immediately
      AVAILABLE).
    - underwriters: `type:OPERATOR_TYPE_UNDERWRITER`, `is_bootstrapped:false` (deposit flow path).
39. **Operator chain links** — `sysio.authex::createlink({chain_kind, account:<operator>, sig, pub_key,
    nonce})` — `[<operator>@active]` — per operator, one EVM link + one SVM link (signed by the operator's own
    active authority over a nonce'd message; **not** `recordlink`):
    - EVM (`chain_kind = CHAIN_KIND_EVM`, 2): `pub_key` = `PUB_EM_*` derived from the anvil mnemonic
      `"test test test test test test test test test test test junk"` at HD path `m/44'/60'/0'/0/<index>`,
      `index` = 1-based operator ordinal (batch ops 1–3, underwriter 4). **(cluster; production: the operator's
      real ETH key.)**
    - SVM (`chain_kind = CHAIN_KIND_SVM`, 3): `pub_key` = the operator node's ED25519 key (the same key its
      `--signature-provider` signs Solana txs with).
40. `sysio.epoch::schbatchgps({})` — `[sysio.epoch@active]` — initialize batch-operator groups from the
    AVAILABLE (bootstrapped) batch ops.
41. `sysio.msgch::bootstrap({})` — `[sysio.msgch@active]` — bootstrap the first epoch (index 0 → 1).

---

## Chain & node configuration (genesis + nodeop)
Not on-chain actions, but the remaining config the tooling sets so the picture is complete.

### `genesis.json` — `initial_configuration` (matches the Python launcher; CPU limits overridden to 400k/375k)
| Field | Value | | Field | Value |
|---|---|---|---|---|
| `initial_key` | `DEV_K1_PUBLIC_KEY` | | `min_transaction_cpu_usage` | `100` |
| `initial_finalizer_key` | `DEV_BLS_PUBLIC_KEY` | | `max_transaction_lifetime` | `3600` |
| `max_block_net_usage` | `1048576` | | `deferred_trx_expiration_window` | `600` |
| `target_block_net_usage_pct` | `10000` | | `max_transaction_delay` | `3888000` |
| `max_transaction_net_usage` | `524288` | | `max_inline_action_size` | `524287` |
| `base_per_transaction_net_usage` | `12` | | `max_inline_action_depth` | `10` |
| `net_usage_leeway` | `500` | | `max_authority_depth` | `10` |
| `context_free_discount_net_usage_num/den` | `20 / 100` | | `max_block_cpu_usage` | `400000` |
| `target_block_cpu_usage_pct` | `10` | | `max_transaction_cpu_usage` | `375000` |

### nodeop arguments & topology
- Extra args (every node): `vote-threads = 4`, `max-transaction-time = -1`, `abi-serializer-max-time-ms =
  990000`, `max-clients = 25`, `connection-cleanup-period = 15`, `http-max-response-time-ms = 990000`. HTTP is
  loosened for local tooling (`access-control-allow-origin/headers = *`, `verbose-http-errors = true`,
  `http-validate-host = false`).
- Plugins — base: `net_plugin`, `chain_api_plugin`; producers add `producer_plugin`, `producer_api_plugin`,
  `trace_api_plugin`; batch operators add `batch_operator_plugin`, `external_debugging_plugin`,
  `outpost_ethereum_client_plugin`, `outpost_solana_client_plugin`, `cron_plugin`; underwriters add
  `underwriter_plugin`, `outpost_ethereum_client_plugin`, `outpost_solana_client_plugin`.
- Ports: producer/API P2P base `9876`, HTTP base `8888`; the bios node uses base − 100 (`9776` / `8788`).

---

## Notes
- **Account creation order is RAM-driven:** only `sysio.roa`/`sysio.acct` are created before ROA (Stage 2);
  EVERY other account — producers included — is created after `system` + `activateroa` (Stage 5) so
  `system::native::newaccount` gifts its RAM from the pool (finite). Creating any account earlier (bios
  `newaccount`, pre-pool) would leave it unlimited, and `setsyscode`'s `giftram` skips unlimited accounts.
- **Raw deploys:** `bios` then `system` (both on `sysio`), and `sysio.roa`. `system` is raw (not **sys**)
  because `setsyscode`'s `giftram` cannot self-target the `sysio` pool account.
- **Genesis vs. handoff keys:** genesis runs on `DEV_K1` (block signer) + `DEV_BLS` (finalizer) — the bios
  node. `setfinalizer` (Stage 1) switches finality to the producer nodes' generated BLS keys, and
  `setprodkeys` (Stage 5) switches production to their generated K1 keys. The `DEV_*` keys remain the
  owner/active key of cluster-created accounts; production replaces all of these with real keys.
- **`activateroa` total_sys:** the bootstrap passes `75496.0000 SYS`. (A `ROA_TOTAL_SYS = 1000000000.0000 SYS`
  constant exists in the tooling but is not what `activateroa` receives — the literal `75496.0000 SYS` is.)
- **Registered ACTIVE, not activated:** `regchain`/`regtoken`/`regctok`/`regreserve` seed their rows ACTIVE at
  bootstrap; there are no `activchain`/`activtoken`/`activctok`/activation actions in the sequence.
- **Execution-order vs. stage grouping:** the tooling's real order differs slightly from this idealized stage
  grouping — `init` runs after the token + authex deploys (here folded into Stage 7), node-owner registration
  (Stage 9) runs before the epoch/opreg config (Stage 10), and `sysio.uwrit::setconfig` (action 36) runs after
  the reserves are seeded. The dependencies (ROA active before `setsyscode`; `setemitcfg` before `initt5`
  before `bootstrap`; node owner registered before operator policies) are what the order actually enforces.
