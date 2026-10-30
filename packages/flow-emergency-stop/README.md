# Emergency stop and recovery

The flow opts into backed mock liquidity and syndication imports. It provisions a
linked Solana holder, releases an initial bonded syndication and queues another
held envelope. Each write is a Report Step and state assertions are verify Steps.

- The panic key freezes Solana. A syndication refuses with `OutpostFrozen`; a
  depot redemption burns shadow but stores a `PendingPayout` without paying the
  holder. A pending-payment call while frozen must refuse without changing the
  record or holder balance. Epochs advance. The packaged `emergencyStop.ts status` and `pending`
  commands run read-only with explicit cluster RPC and wallet environment and
  retain their output in the cluster directory.
- The panic account pulls the depot cord. Bond acceptance and challenge still
  work; crank releases nothing, while desyndication, plain-account transfers
  and bond claims refuse. Epochs advance and bucket rows stay unchanged.
- Recovery clears Solana before the depot. The stored payment increases the
  holder's ATA by its exact amount and closes the PDA. A second on-chain call
  uses the original manifest and must refuse. Crank releases the due envelope.
- Governance creates an intentional custody shortfall using measured slack plus
  10,000,000 units. A real Solana syndication produces one mismatch and pulls the
  depot cord as `sysio.synd`. The probe mismatch also matches LIQSOL, syndication
  kind, and its admitted epoch. Donation repairs custody. A new syndication reports
  the repaired balance; the depot cursor must admit its sequence before the cord
  clears. Earlier in-flight messages may add mismatches, all recorded in the
  Report. No mismatch at or beyond the repaired sequence is permitted. After clear,
  `sysio` validates both recovery deposits, and the normal release queue must deliver
  both amounts to the user's wallet, including the existing recredited baseline.
- Ethereum's imported position exercises explicit pause, a positive custody gap
  within the live on-chain allowance, and automatic `CUSTODY_SHORTFALL` pause
  beyond that allowance. Fixture sizing includes measured custody slack, the
  net redemption after live fees, post-burn outstanding and integer rounding.
  The tolerated gap targets half the maximum; the refused gap exceeds the first
  disallowed unit by 10,000,000 depot units to allow minor custody drift. The
  payout itself remains fully funded. Receipt-backed custody-check events verify
  the actual ratio at settlement, including any custody changes since measurement.
  The tolerated payout must transfer exactly once without pausing or storing a
  pending record. Each stored redemption is paid after recovery in
  native wei (depot units times 1,000,000,000), and a second call refuses. Before
  each unpause, a pending-payment call must refuse with `EnforcedPause`, preserving
  the complete record and holder balance. Each custody lane pre-funds a donor
  before measuring the final fixture: deposits charge fees and can rebase the
  pool and recipient. The donor's actual minted balance must cover the complete
  repair. Donation is a separate Step, followed by a full-backing check before
  recovery. Ethereum funding is independent of Solana's fixed deficit.
  Production custody allowances are preserved.

The pre-repair mismatches are permanent evidence; recovery asserts no mismatch
at or beyond the post-repair sequence, with all earlier rows preserved.
The flow requires Ethereum PR #271's inclusive custody allowance and custody-check
events. Focused tests cover the exact boundary, the first depot unit beyond it,
live allowance reads, full funding, settlement evidence and recovery ordering.

Run with the canonical scripts:

```sh
node scripts/run-flow.mjs flow-emergency-stop --cluster-path <fresh-dir> \
  --wire-build-path <wire-sysio>/build/release \
  --ethereum-path <wire-ethereum> --solana-path <wire-solana>
node scripts/flow-heartbeat-monitor.mjs --cluster-path <fresh-dir> --expect-freeze
```

Only this deliberate freeze flow uses `--expect-freeze`. Epoch stalls remain
fatal. The monitor recognizes the expected `EnforcedPause` and
`WIRE_NoPendingDesyndication` refusals by name or raw Ethereum selector;
unrelated errors remain fatal. No per-flow environment customization is needed.

Focused helper tests use Node’s built-in test runner (`pnpm run test:unit` in
this package). The root test gate discovers `test:unit` scripts generically
after Jest; these tests never launch a cluster.
