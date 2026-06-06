# Wire production bootstrap sequence

Canonical, ordered list of on-chain actions to bootstrap a Wire chain. The cluster tooling (wire-tools-ts)
mirrors this; the values below are its production-mirror defaults. **Structural** values (core symbol,
chain/token codes, tiers, ROA byte price) are fixed; **economic / sizing** values (supplies, weights, fees,
collateral, epoch duration, counts, producer/finalizer set, keys) are deployment-tunable — production
substitutes real keys, the real finalizer set, and final economic policy.

## Conventions
- `account::action` — the contract account the action lives on. NOTE: `bios` and `system` both deploy to the
  **`sysio`** account itself (no separate `sysio.bios`/`sysio.system` account); `system` replaces `bios`.
- Auth in `[brackets]` — the `-p` authorization.
- **raw** = `sysio::setcode` + `sysio::setabi` (the `sysio`-account contracts `bios`/`system`, plus `sysio.roa`).
- **sys** = `sysio.roa::setsyscode(account,vmtype,vmversion,code)` (inline `setcode`+`setpriv`+`giftram`) +
  `sysio.roa::setsysabi(account,abi)` (inline `setabi`+`giftram`). Privileged + RAM gifted from the `sysio`
  pool; requires ROA active; cannot target `sysio` (giftram self-reference). `code` = raw wasm bytes (hex);
  `abi` = PACKED `abi_def` bytes; `vmtype=vmversion=0`.

## RAM model — no unlimited accounts
Every account's RAM is **finite** and **gifted from the `sysio` pool** as a conserving transfer (never minted):
- **`activateroa`** partitions `total_sys * bytes_per_unit` into node-owner reserves + `sysio.roa` allocation
  (`leftover/2`) + the `sysio` pool + the `sysio.acct` seed, and sets finite limits on `sysio`, `sysio.roa`,
  `sysio.acct`.
- **Account creation** (`system::native::newaccount`): `set_resource_limits(new, 0,0,0)` then
  `transfer_ram(sysio, new, newaccount_ram)` — the new account gets a finite limit funded from the pool. This
  requires `system` deployed AND ROA active, so all non-essential accounts are created **after** Stage 4.
- **Contract code/abi** (**sys** deploy -> `giftram`): tops up the contract account's limit by exactly the
  code/abi bytes from the pool. `giftram` SKIPS unlimited accounts, so the account must already be finite.
- **System-contract table rows** — config/state/registration/log rows on the separate-account system
  contracts (`sysio.token` plus the OPP set: epoch, opreg, uwrit, dclaim, chains, tokens, reserv, chalg, msgch)
  — are billed directly to `sysio` via a per-contract `ram_payer = "sysio"_n` (privileged-contract model).
  `setsyscode`'s `giftram` covers only code/abi, so a self-billed row would overflow the contract's exact
  limit; routing rows to the pool keeps each contract account finite at code/abi size. `bios`/`system` code
  lives on `sysio` and likewise consumes the pool directly.
- **Only transiently unlimited** during bring-up: `sysio` (genesis), `sysio.roa`, `sysio.acct` — all set finite
  by `activateroa`. No account is permanently unlimited.
- Invariant: `sysio` pool remaining + `sysio.acct` bucket == initial pool; grand total across {node-owner
  reserves + roa allocation + `sysio` pool + every gifted account/contract} == `total_sys * bytes_per_unit`.

## Governance & privilege
- **All `sysio.*` accounts: owner = active = `sysio@active`** — an account-authority delegating to `sysio`
  (`{threshold:1, keys:[], accounts:[{permission:{actor:"sysio",permission:"active"},weight:1}], waits:[]}`); no
  standalone key. Governance (`sysio`, msig-backed in production) controls every system account and signs every
  `[sysio.X@active]` step. Stage 8 only ADDS `@sysio.code` weights on top of that `sysio@active` base (never
  removes it) — a contract's own code permission on its owner authority, cross-contract delegations on active.
- All system contracts are privileged: `sysio`/`bios`/`system` from genesis; the **sys**-deployed set via
  `setsyscode`. Hard requirements (from source): `sysio.token` (bills rows to `sysio`), `sysio.msig`,
  `sysio.wrap` (both `act.send()` arbitrary-auth actions).
- **DEV_K1**/**DEV_BLS** — dev keys for non-system accounts only (producers, operators/underwriters) + block
  signing / finalizer; production uses real keys.

## Key values (production-mirror defaults)
- Core symbol `4,SYS`; ROA `bytes_per_unit = 104`; `newaccount_ram` = base RAM gifted per account.
- `ROA_TOTAL_SYS = 1000000000.0000 SYS` (activateroa `total_sys`).
- `TOKEN_MAX_SUPPLY = 1000000000.0000 SYS`; `PRODUCER_INITIAL_FUNDS = 1000000.0000 SYS`; `MAX_PRODUCERS = 21`.
- Finalizer threshold = `floor(N*2/3)+1`. Resource policy weights: `net=cpu=ram=25.0000 SYS`, `time_block=0`,
  `network_gen=0`.
- WIRE token `9,WIRE`, max `1000000000.000000000 WIRE`. Emissions (`setemitcfg`): `t1/t2/t3 = 7.5M/15M/30M
  WIRE` (x1e9), `min_claimable=10 WIRE`, `target_annual_decay_bps=6940`, splits `compute=4000/capex=2000/
  governance=1000` (capital reserve 3000), compute sub-split `producer=7000/batch_op=3000`,
  `epoch_log_retention_count=8640`, `pay_cadence_epochs=1`.
- Operator caps: `producers=21`, `batch_ops=63`, `underwriters=21`. Underwriter `fee_bps=10`, `lock=10` epochs.
- Chains: `WIRE`(0, depot/self), `ETHEREUM`(real EVM chain id), `SOLANA`(0) — codes are `slug_name`.
  Tokens: `WIRE, ETH, LIQETH, USDC, USDT, SOL, LIQSOL, USDCSOL, USDTSOL` + chain-token bindings.

---

## Stage 1 — Core chain bring-up (bios on `sysio`, raw)
1. deploy `bios` -> `sysio` — **raw** — [sysio@active] — `setcode`/`setabi(sysio, bios.wasm/abi)`.
2. `sysio::activate(feature_digest)` — [sysio@active] — `PREACTIVATE_FEATURE` first, then every supported digest.
3. `sysio::setfinalizer({finalizer_policy:{threshold = floor(N*2/3)+1, finalizers:[{weight, public_key:DEV_BLS}
   ...]}})` — [sysio@active]. The chain finalizes on the node BLS keys and keeps producing on the genesis
   `sysio` producer until the Stage 5 handoff — no early `setprods` is issued (producer accounts don't exist
   yet, and creating them pre-pool would leave them unlimited).

## Stage 2 — Bring-up-essential accounts only (native `newaccount`, pre-ROA)
4. `sysio::newaccount` — [sysio@active] — create only what Stage 3 needs: **`sysio.roa`** (to host the contract)
   and **`sysio.acct`** (activateroa sets its bucket), both owner=active=`sysio@active`. These are transiently
   unlimited (bios doesn't gift); `activateroa` sets both finite next. Nothing else is created pre-pool.

## Stage 3 — ROA activation (establishes the RAM pool; makes sysio/roa/acct finite)
5. deploy `sysio.roa` -> `sysio.roa` — **raw** — [sysio@active].
6. `sysio::setpriv("sysio.roa", 1)` — [sysio@active].
7. `sysio.roa::activateroa({total_sys:ROA_TOTAL_SYS, bytes_per_unit:104})` — [sysio.roa@active] — **RAM POOL
   ESTABLISHED**; sets finite limits on `sysio`, `sysio.roa` (`leftover/2`), `sysio.acct` (seed).
   (No node owner is registered in the core bootstrap. `forcereg` is NOT used — node owners enter ONLY via
   the real `nodeownreg` flow, which runs post-bootstrap once ROA is active and the sysio.code delegations
   are wired; see Stage 10. The genesis `sysio` account produces and finalizes until the Stage 5 handoff.)

## Stage 4 — Replace bios with system (on `sysio`, raw) + init
9. deploy `system` -> `sysio` — **raw** — [sysio@active] — replaces bios; billed to `sysio` (pool quota).
   Enables the RAM-gifting `newaccount` for Stage 5.
10. `sysio::init({version:0, core:"4,SYS"})` — [sysio@active].

## Stage 5 — Create ALL remaining accounts (pool-gifted finite) + producer handoff
Every account here is created via `system::newaccount`, which gifts `newaccount_ram` from the `sysio` pool
(`set_resource_limits(new,0,0,0)` + `transfer_ram(sysio,new,newaccount_ram)`) — so each is FINITE, never
unlimited. NO account in the chain is permanently unlimited.
11. **Producer accounts** — `sysio::newaccount({creator:"sysio", name, owner:<producer key>, active:<producer
    key>})` x producers — [sysio@active]. Producers keep their own block-signing keys (not `sysio@active`), but
    their RAM is pool-gifted like everything else.
12. **Remaining `sysio.*` accounts** — `sysio::newaccount({creator:"sysio", name, owner:sysio@active,
    active:sysio@active})` x N — [sysio@active]: `sysio.token`, `sysio.msig`, `sysio.wrap`, `sysio.authex`,
    `sysio.chains`, `sysio.tokens`, `sysio.epoch`, `sysio.opreg`, `sysio.msgch`, `sysio.uwrit`, `sysio.reserv`,
    `sysio.chalg`, `sysio.dclaim`, `sysio.gov`, `sysio.ops`, `sysio.noop`, `sysio.bpay`, `sysio.vpay`,
    `sysio.names`.
13. `sysio::setprodkeys({schedule:[{producer_name, block_signing_key}...]})` — [sysio@active] — set the real
    producer schedule and wait for handoff off the genesis `sysio` producer.

## Stage 6 — Deploy separate-account privileged contracts (sys)
For each: `sysio.roa::setsyscode({account, vmtype:0, vmversion:0, code:<wasm hex>})` then
`sysio.roa::setsysabi({account, abi:<packed abi hex>})`, both [sysio@active] — gifts code/abi RAM from the pool:
14. `sysio.token`
15. `sysio.msig`
16. `sysio.wrap`
17. `sysio.authex`
18. OPP set: `sysio.chains`, `sysio.tokens`, `sysio.epoch`, `sysio.opreg`, `sysio.msgch`, `sysio.uwrit`,
    `sysio.reserv`, `sysio.chalg`, `sysio.dclaim`.

## Stage 7 — Token + emissions
19. `sysio.token::create({issuer:"sysio", maximum_supply:"1000000000.0000 SYS"})` — [sysio.token@active].
20. `sysio.token::issue({to:"sysio", quantity:"1000000000.0000 SYS", memo:"initial issue"})` — [sysio@active].
21. `sysio.token::transfer({from:"sysio", to:<producer>, quantity:"1000000.0000 SYS", memo:"init"})` x producers
    — [sysio@active].
22. `sysio.token::create` + `issue` WIRE (`maximum_supply:"1000000000.000000000 WIRE"`, to `sysio`).
23. `sysio::setemitcfg({...allocations, target_annual_decay_bps:6940, compute_bps:4000, capex_bps:2000,
    governance_bps:1000, producer_bps:7000, batch_op_bps:3000, epoch_log_retention_count:8640,
    pay_cadence_epochs:1})` then `sysio::initt5(...)` — [sysio@active].

## Stage 8 — Cross-contract `sysio.code` delegations (`sysio::updateauth`, [target@owner])
Each re-sets the target's active to **`sysio@active` plus the needed `@sysio.code` weights** (keeps governance;
no key), accounts sorted by actor:
24. `sysio.active` <- (genesis governance authority) + `sysio.authex@sysio.code` (sysio is not a `sysio.*`
    account — keep its own authority, add the weight).
25. each OPP contract `.active` <- `sysio@active` + own `@sysio.code`.
26. `sysio.opreg.active` <- `sysio@active` + `sysio.msgch@sysio.code`.
27. `sysio.roa.active` <- `sysio@active` + `sysio.msgch@sysio.code` + `sysio.roa@sysio.code`.
28. `sysio.authex.active` <- `sysio@active` + `sysio.authex@sysio.code` + `sysio.roa@sysio.code`.

## Stage 9 — OPP / application config
29. `sysio.epoch::setconfig({epoch_duration_sec, operators_per_epoch, batch_op_groups,
    batch_operator_minimum_active = operators_per_epoch*batch_op_groups, epoch_log_retention_count})`.
30. `sysio.opreg::setconfig({max_available_producers:21, max_available_batch_ops:63,
    max_available_underwriters:21, <collateral mins>, <termination thresholds>})`.
31. `sysio.uwrit::setconfig({fee_bps:10, collateral_lock_duration_epoch_count:10, <fee splits>})`.
32. `sysio.dclaim::setconfig(...)` + `setclmwindow(...)` + `importseed(...)` + `importdone()`.
33. `sysio.chains::regchain({code:slug("WIRE"),external_chain_id:0})`, `slug("ETHEREUM")`/EVM-id,
    `slug("SOLANA")`/0; then `activchain(code)` each.
34. `sysio.tokens::regtoken({code:slug(name)})` for the token set; `regctok({chain_code,token_code})` bindings;
    `activtoken`/`activctok`.
35. `sysio.reserv::regreserve({chain_code, token_code, kind:PRIMARY, <seed>})` per chain-token.

## Stage 10 — Post-bootstrap operations (node owner, operators, first epoch)
Performed by a real node owner, not the core bootstrap; the genesis `sysio` account remains
producer/finalizer. NOTHING here uses `forcereg`.
36. **Register the bootstrap node owner** (e.g. `wireno`, 2-6 chars for tier 1) via the real claim flow:
    `sysio.roa::newnameduser({account, pubkey:<wire key>, tier:1})` then
    `sysio.roa::nodeownreg({owner:account, tier:1, eth_pub_key:<EM secp256k1 key>, wire_pub_key:<wire key>})`
    — [sysio.roa@active]. Records the ETH key as a `sysio.authex` link and allocates the tier-1 reserve the
    node owner issues operator policies from. (Cluster: a throwaway `PUB_EM_*`; production: the NFT
    depositor's key, dispatched by the `sysio.msgch` depot.)
37. `sysio::newaccount(operator/underwriter, DEV_K1)` + `sysio.roa::addpolicy({owner, issuer:<node owner>,
    net_weight:"25.0000 SYS", cpu_weight:"25.0000 SYS", ram_weight:"25.0000 SYS", time_block:0,
    network_gen:0})` — [sysio@active / <node owner>@active] — finite RAM from the node owner's reserve.
38. `sysio.opreg::regoperator({operator, ..., is_bootstrapped})` — batch operators (`true`) + underwriters
    (`false`) — [sysio.opreg@active].
39. `sysio.authex::recordlink({account, chain_kind, pub_key})` — operator ETH/SOL links — [sysio.authex@active].
40. `sysio.epoch::schbatchgps(...)` — [sysio.epoch@active].
41. `sysio.msgch::bootstrap(...)` — [sysio.msgch@active] — bootstrap the first epoch (0 -> 1).

---

## Notes
- **Account creation order is RAM-driven:** only `sysio.roa`/`sysio.acct` are created before ROA (Stage 2);
  EVERY other account — producers included — is created after `system` + `activateroa` (Stage 5) so
  `system::newaccount` gifts its RAM from the pool (finite). Producers wait until Stage 5 (the genesis `sysio`
  producer carries the chain until then); creating any account earlier (bios newaccount, pre-pool) would leave
  it unlimited, and `setsyscode`'s `giftram` skips unlimited accounts.
- **Raw deploys:** `bios` then `system` (both on `sysio`), and `sysio.roa`. `system` is raw (not **sys**)
  because `setsyscode`'s `giftram` cannot self-target the `sysio` pool account.
- ROA is activated **early** (Stage 3); the chain produces on the bios schedule (Stage 1) until the system
  handoff (Stage 4). bios stays on `sysio` through every bios-only action; `system` then provides `setpriv` for
  the **sys** deploys.
