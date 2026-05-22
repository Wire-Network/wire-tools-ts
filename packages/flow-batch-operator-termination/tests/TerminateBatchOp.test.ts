import "jest"
import Fs from "node:fs"
import Path from "node:path"
import { ethers } from "ethers"
import { match, P } from "ts-pattern"
import * as anchor from "@coral-xyz/anchor"
import { Connection, Keypair, PublicKey } from "@solana/web3.js"
import {
  ChainKind,
  OperatorStatus,
  OperatorType,
  TokenKind
} from "@wireio/opp-typescript-models"
import {
  Bytes,
  SlugName,
  KeyType,
  PrivateKey,
  SystemContracts
} from "@wireio/sdk-core"
import {
  depositETHCollateral,
  depositSOLCollateral,
  FlowTestContext,
  log,
  pollUntil,
  ProcessManager,
  provisionFreshBatchOperator,
  type FreshBatchOperator,
  SOLClient
} from "@wireio/test-cluster-tool"

/**
 * Flow: Batch Operator Termination via Delivery Underperformance — multi-chain bond.
 *
 * Verifies the full protocol promise that an operator becomes ACTIVE only
 * after posting required collateral on **every active outpost**, and on
 * termination the bonded collateral is remitted back from every outpost's
 * vault. The previous iteration used a bootstrapped operator (`batchop.a`,
 * `is_bootstrapped=true`) which is ACTIVE-by-fiat and never bonds —
 * sidestepping the requirement entirely (the "false positive" surfaced
 * in `feedback_full_protocol_requirements.md`).
 *
 * Sequence:
 *   1. Bootstrap a cluster with `req_batchop_collat` populated for both
 *      ETHEREUM/ETH and SOLANA/SOL (the depot-side enforcement that
 *      makes the test meaningful).
 *   2. Post-bootstrap, create `batchop.fresh`:
 *        - createAccount + sysio.roa addpolicy
 *        - authex `createlink` for ETH (HD-derived) and SOL (random ED)
 *        - regoperator(is_bootstrapped=false) signed as opreg
 *   3. Deposit collateral on ETH via OperatorRegistry.deposit (emits
 *      OPERATOR_ACTION(DEPOSIT_REQUEST) → depot credits balance row).
 *   4. Deposit collateral on SOL via opp_outpost::deposit ix (same path
 *      from the SOL side).
 *   5. Wait for status flip to ACTIVE (depot's eligibility predicate
 *      sees both `req_batchop_collat` rows satisfied → processbatch
 *      inline flips status).
 *   6. Wait for `batchop.fresh` to appear in `sysio.epoch::batch_op_groups`
 *      (proves the group-rebuild promoted it into the rotation).
 *   7. DO NOT spawn a nodeop for `batchop.fresh`. With the op in
 *      rotation but no SBP running for it, every scheduled epoch
 *      accumulates a `recorddel(delivered=false)` row.
 *   8. After ≥ `terminate_max_consecutive_misses` consecutive missed
 *      epochs (test overrides to 2), `termcheck` flips status to
 *      TERMINATED and the depot emits OPERATOR_ACTION(WITHDRAW_REMIT)
 *      to both outposts.
 *   9. Verify TERMINATED + `terminated_at>0` + non-empty `status_reason`.
 *  10. Verify the depot's outbound envelope log contains a
 *      WITHDRAW_REMIT targeting `batchop.fresh` for each outpost.
 *  11. Verify the ETH outpost's `depositedByKind` for the fresh op's
 *      ETH address returns to 0 once the ETH cranker processes the
 *      inbound WITHDRAW_REMIT (and the fresh op's ETH wallet balance
 *      rose by ≈ MIN_ETH_BOND minus tx fees).
 *  12. Verify the same for SOL: the on-chain `collateral_by_kind`
 *      ledger entry decremented to 0, AND the fresh op's SOL wallet
 *      balance rose by ≈ MIN_SOL_BOND once the cranker's envelope
 *      decode pulled the fresh op's pubkey into `remaining_accounts`
 *      on the final `epoch_in` chunk submission and the on-chain
 *      handler did the vault → operator CPI transfer.
 *
 * Per `feedback_batch_op_group_odd_sizing.md`, 9 bootstrapped batch ops
 * → 3 groups × 3 ops/group; the 10th non-bootstrapped op lands wherever
 * sysio.epoch's group-rebuild places it. With the suppressed op never
 * delivering, the other 8 bootstrapped batchops still cover consensus
 * majority on every group.
 */

// ──────────────────────────────────────────────────────────────────────
//  Config
// ──────────────────────────────────────────────────────────────────────

/** Epoch duration matches the bare-cluster working baseline. */
const TEST_EPOCH_DURATION_SEC = 60

/** Bond size for `batchop.fresh` on each chain. Both ledger rows are
 *  zeroed on termination so the exact value just needs to clear the
 *  per-role min_bond floor. 2 000 000 base units = 2e6 SYS/wei/lamport
 *  scale, plenty above the configured 1 000 000 minimum below. */
const FLOW_E_MIN_ETH_BOND = 2_000_000n
const FLOW_E_MIN_SOL_BOND = 2_000_000n

/** `req_batchop_collat` floor each chain. */
const FLOW_E_REQ_ETH_MIN_BOND = 1_000_000
const FLOW_E_REQ_SOL_MIN_BOND = 1_000_000

/** HD slot for the fresh op's ETH wallet — must sit past every
 *  bootstrapped operator slot (batchops + underwriters) so the anvil
 *  mnemonic derivation doesn't collide. `buildEthereumOperatorWallets`
 *  assigns batchops to `slotIndex = 0..N-1` (hdIndex 1..N) and
 *  underwriters to `slotIndex = N..N+M-1` (hdIndex N+1..N+M). With the
 *  this flow's config (batchOperatorCount=9, underwriterCount default=1)
 *  that's hdIndex 1..10 — so 11 is the first safe slot. */
const FRESH_OP_HD_INDEX = 11

/** Account name for the fresh operator. WIRE accounts are capped at 12
 *  characters by `sysio::newaccount`; `batchop.fresh` (13 chars) was the
 *  original choice but trips that limit, so the test uses a 7-char
 *  semantic equivalent. The bootstrap registers ops as `batchop.[a-i]`
 *  (9 chars each) and `freshop` slots cleanly in the same name space
 *  without colliding. */
const FRESH_OP_NAME = "freshop"

const MsPerSecond = 1_000

const PollDeadlineBufferMs = 30_000
const LongPollIntervalMs   = 3_000
const BootstrapTimeoutMs   = 300_000

/** Epochs to wait for termination after both deposits land + ACTIVE
 *  flip. With `terminateMaxConsecutiveMisses=2`, the suppressed op
 *  needs to be scheduled on at least 2 consecutive groups; with 3
 *  groups the fresh op's slot rotates every 3 epochs in the worst case,
 *  so 10 epochs is comfortably above the ~6-epoch theoretical worst. */
const MissAccumulationEpochs = 10

/** Override for `terminate_max_consecutive_misses` so termcheck fires
 *  inside the test budget. */
const FlowETerminateMaxConsecutiveMisses = 2

/** Epochs allowed for the WITHDRAW_REMIT outbound → cranker → outpost
 *  inbound round-trip after termination. */
const RemitPropagationEpochs = 8

// Pre-bootstrap-created account whose K1 key was loaded into kiod by
// the harness — used to sign new account creations on the WIRE side.
// Account creation, ROA policy, ETH HD derivation, SOL airdrop, authex
// links, and regoperator(is_bootstrapped=false) all live inside the
// shared `provisionFreshBatchOperator` helper now — see
// `.claude/rules/flow-test-scenario-structure.md`.

// ──────────────────────────────────────────────────────────────────────
//  Enum-comparison helpers (chain_plugin can return enums as either the
//  numeric value or the proto-spelling string)
// ──────────────────────────────────────────────────────────────────────

const isStatus = (raw: unknown, want: OperatorStatus): boolean =>
  match(raw)
    .with(P.number, n => n === want)
    .with(P.string, s => s === `OPERATOR_STATUS_${OperatorStatus[want]}`)
    .otherwise(() => false)

const isType = (raw: unknown, want: OperatorType): boolean =>
  match(raw)
    .with(P.number, n => n === want)
    .with(P.string, s => s === `OPERATOR_TYPE_${OperatorType[want]}`)
    .otherwise(() => false)

// ──────────────────────────────────────────────────────────────────────
//  Test suite
// ──────────────────────────────────────────────────────────────────────

describe("Flow: Termination via miss-window (non-bootstrapped op, two-chain bond)", () => {
  let ctx: FlowTestContext
  let opRegContract: ethers.Contract
  let opRegAddress: string

  // Fresh non-bootstrapped batch op provisioned in beforeAll via
  // `provisionFreshBatchOperator`. The individual handles are
  // mirrored from `freshOp` for ergonomic per-test access.
  let freshOp:          FreshBatchOperator
  let freshEthWallet:   ethers.HDNodeWallet
  let freshEthPubkey33: Uint8Array
  let freshSolKeypair:  Keypair
  let freshSolPubkey:   PublicKey

  let solConnection: Connection
  let oppProgram: anchor.Program<anchor.Idl>

  /**
   * Post-deposit snapshots of freshop's chain-native wallet balances, captured
   * after BOTH bonds have landed but BEFORE termination begins. The
   * WITHDRAW_REMIT assertions further down compare against these to enforce
   * the exact "remit credits bond amount" invariant — not just "balance is
   * above some floor". freshop signs no transactions between deposit and
   * remit (the cranker pays gas + tx fees on its own wallet), so the post-
   * remit balance MUST equal `post_deposit + FLOW_E_MIN_*_BOND` to the wei /
   * lamport. Any drift would indicate either a miscounted refund amount on
   * the depot side or a partial transfer on the outpost handler.
   */
  let postDepositEthWei: bigint = 0n
  let postDepositSolLamports: number = 0

  beforeAll(async () => {
    ctx = await FlowTestContext.create({
      epochDurationSec: TEST_EPOCH_DURATION_SEC,
      batchOperatorCount: 9,
      terminateMaxConsecutiveMisses: FlowETerminateMaxConsecutiveMisses,
      // Depot must enforce "ACTIVE requires deposit on every active
      // outpost" — otherwise a fresh op flips ACTIVE on the empty
      // requirement check and the test would green on incomplete config
      // (the failure mode that motivated this rewrite).
      reqBatchopCollat: [
        {
          chainCode: SlugName.from("ETHEREUM"),
          tokenCode: SlugName.from("ETH"),
          minBond: FLOW_E_REQ_ETH_MIN_BOND
        },
        {
          chainCode: SlugName.from("SOLANA"),
          tokenCode: SlugName.from("SOL"),
          minBond: FLOW_E_REQ_SOL_MIN_BOND
        }
      ]
    })

    const ethAddrs = ctx.loadETHAddresses()
    opRegAddress  = ethAddrs.OperatorRegistry
    opRegContract = new ethers.Contract(
      opRegAddress,
      ctx.loadETHABI("OperatorRegistry"),
      ctx.ethSigner
    )

    // SOL connection + Anchor program — built from solanaPath's deployed
    // IDL. The IDL embeds the program-id, so callers don't pass it.
    if (!ctx.solanaPath) {
      throw new Error("flow-batch-operator-termination requires WIRE_SOLANA_PATH so the harness can load opp_outpost IDL")
    }
    solConnection = new Connection(`http://127.0.0.1:${ctx.ports.solanaRpc}`, "confirmed")
    const idlFile = Path.join(ctx.solanaPath, "target", "idl", "opp_outpost.json")
    const idl     = JSON.parse(Fs.readFileSync(idlFile, "utf8")) as anchor.Idl
    // AnchorProvider needs a wallet; we replace it per-call with the
    // depositor's keypair, so a placeholder is fine here.
    const placeholder = Keypair.generate()
    const provider    = new anchor.AnchorProvider(
      solConnection,
      new anchor.Wallet(placeholder),
      { commitment: "confirmed" }
    )
    oppProgram = new anchor.Program(idl, provider)

    // ── Scenario provisioning: fresh non-bootstrapped batch op ──
    // Per `.claude/rules/flow-test-scenario-structure.md`,
    // scenario-specific setup happens in `beforeAll`. The harness
    // substrate only registers BOOTSTRAPPED operators, and
    // `bootstrapped-operator-invariants.md` makes them immune to the
    // termination machinery — exactly what this flow needs to NOT
    // happen to its target operator.
    freshOp = await provisionFreshBatchOperator(ctx, {
      account:        FRESH_OP_NAME,
      ethHdIndex:     FRESH_OP_HD_INDEX,
      solConnection,
      solAirdropFloor: 5_000_000_000
    })
    freshEthWallet   = freshOp.ethWallet
    freshEthPubkey33 = freshOp.ethCompressedPubkey
    freshSolKeypair  = freshOp.solKeypair
    freshSolPubkey   = freshOp.solPublicKey
  }, BootstrapTimeoutMs)

  afterAll(async () => {
    try {
      await ctx?.teardown()
    } catch (err) {
      log.error("Error during teardown:", err)
    }
    await ProcessManager.get().killAll()
  }, 30_000)

  // ── Chain health ──

  test("WIRE chain is producing blocks", async () => {
    const info = await ctx.wireClient.getInfo()
    expect(Number(info.head_block_num)).toBeGreaterThan(0)
  })

  test("Anvil + OperatorRegistry reachable", async () => {
    const code = await ctx.ethProvider.getCode(opRegAddress)
    expect(code.length).toBeGreaterThan(4)
  })

  test("Solana test-validator reachable", async () => {
    const slot = await solConnection.getSlot()
    expect(slot).toBeGreaterThan(0)
  })

  // ── freshop provisioned in beforeAll ──

  test("freshop registered as non-bootstrapped batch op with status=UNKNOWN", async () => {
    // Post-condition of `provisionFreshBatchOperator` — the operator
    // row exists with status=UNKNOWN (no deposits yet —
    // meets_role_min iterates req_batchop_collat and every
    // available(...) returns 0).
    const { rows } = await ctx.wireClient.getOperators()
    const fresh    = rows.find((op: any) => op.account === FRESH_OP_NAME)
    expect(fresh).toBeDefined()
    expect(isStatus(fresh.status, OperatorStatus.UNKNOWN)).toBe(true)
  })

  // ── ETH deposit → depot ledger ──

  test(
    "deposit ETH collateral; depot credits ETH balance row but op stays UNKNOWN",
    async () => {
      // Fund the operator's ETH wallet — anvil-mnemonic HD #10 starts
      // at 0 balance.
      const funder      = (await ctx.ethProvider.getSigner(0))
      const fundTx      = await funder.sendTransaction({
        to:    freshEthWallet.address,
        value: ethers.parseEther("0.5")
      })
      await fundTx.wait()

      const opReg = opRegContract.connect(freshEthWallet) as ethers.Contract & {
        deposit: (
          operatorType: number,
          compressedPubkey: Uint8Array,
          tokenCode: bigint,
          amount: bigint,
          overrides?: ethers.Overrides & { value?: bigint }
        ) => Promise<ethers.ContractTransactionResponse>
        nativeTokenCode: () => Promise<bigint>
      }
      await depositETHCollateral(
        opReg,
        OperatorType.BATCH,
        freshEthPubkey33,
        BigInt(SlugName.from("ETH")),
        FLOW_E_MIN_ETH_BOND
      )

      // Wait for the depot to apply the DEPOSIT_REQUEST → depositinle
      // path. The operator's `balances` row for (ETHEREUM, ETH) appears
      // with non-zero amount; status stays UNKNOWN because the SOL
      // requirement isn't yet satisfied.
      await pollUntil(
        "depot ETH balance row for batchop.fresh ≥ min_bond",
        async () => {
          const { rows } = await ctx.wireClient.getOperators()
          const op       = rows.find((o: any) => o.account === FRESH_OP_NAME)
          if (!op) return false
          // v6: balance entry's chain identifier is `chain_code` (a
          // slug_name `{value: uint64}`), not `chain` (ChainKind enum).
          const balances   = op.balances ?? []
          const ethCodeNum = SlugName.from("ETHEREUM")
          const ethRow     = balances.find(
            (b: any) => Number(b.chain_code?.value ?? b.chain_code) === ethCodeNum
          )
          if (!ethRow) return false
          return Number(ethRow.balance) >= FLOW_E_REQ_ETH_MIN_BOND
        },
        TEST_EPOCH_DURATION_SEC * 4 * MsPerSecond,
        LongPollIntervalMs
      )

      const { rows } = await ctx.wireClient.getOperators()
      const fresh    = rows.find((op: any) => op.account === FRESH_OP_NAME)
      expect(isStatus(fresh.status, OperatorStatus.UNKNOWN)).toBe(true)
    },
    TEST_EPOCH_DURATION_SEC * 4 * MsPerSecond + PollDeadlineBufferMs
  )

  // ── SOL deposit → depot ledger ──

  test(
    "deposit SOL collateral; depot credits SOL balance row and status flips ACTIVE",
    async () => {
      // Re-bind the Anchor provider's signer to the depositor so the
      // CPI signing flow goes through their keypair.
      const provider = new anchor.AnchorProvider(
        solConnection,
        new anchor.Wallet(freshSolKeypair),
        { commitment: "confirmed" }
      )
      const program  = new anchor.Program(oppProgram.idl, provider)

      await depositSOLCollateral(
        solConnection,
        program,
        freshSolKeypair,
        OperatorType.BATCH,
        BigInt(SlugName.from("SOL")),
        FLOW_E_MIN_SOL_BOND
      )

      // The SOL DEPOSIT_REQUEST rides on the next outbound envelope from
      // the SOL outpost back to the depot. Once depot's depositinle
      // credits the SOL balance row, the eligibility predicate sees
      // both rows satisfied and processbatch flips status to ACTIVE.
      await pollUntil(
        "depot batchop.fresh status flips to ACTIVE after SOL deposit lands",
        async () => {
          const { rows } = await ctx.wireClient.getOperators()
          const op       = rows.find((o: any) => o.account === FRESH_OP_NAME)
          return op != null && isStatus(op.status, OperatorStatus.ACTIVE)
        },
        TEST_EPOCH_DURATION_SEC * 6 * MsPerSecond,
        LongPollIntervalMs
      )

      // Snapshot post-deposit wallet balances on BOTH chains. The
      // WITHDRAW_REMIT tests below compare against these to assert the
      // exact `+ FLOW_E_MIN_*_BOND` increment after the outpost handlers
      // process the inbound remit. See the post-remit assertion comments
      // for why these are wei/lamport-exact, not tolerance-windowed.
      postDepositEthWei      = await ctx.ethProvider.getBalance(freshEthWallet.address)
      postDepositSolLamports = await solConnection.getBalance(freshSolPubkey)
    },
    TEST_EPOCH_DURATION_SEC * 6 * MsPerSecond + PollDeadlineBufferMs
  )

  // ── Rebuild groups to include batchop.fresh ──

  test(
    "batchop.fresh enters the schedule window via advance's new-tail computation",
    async () => {
      // The sliding-window schedule (see
      // .claude/rules/batch-operator-schedule-window.md) folds newly-ACTIVE
      // non-bootstrapped operators in as part of each `advance`'s new-tail
      // computation. `schbatchgps` is one-shot at bootstrap; we do NOT call
      // it post-bootstrap. Just wait for freshop to ride into a tail group
      // — at most N advances after she went ACTIVE (with N=3 groups, ≤3
      // epochs), and since she's non-bootstrapped she gets picked first.
      await pollUntil(
        `${FRESH_OP_NAME} appears in epoch_state.batch_op_groups`,
        async () => {
          try {
            const result = await ctx.wireClient.getTableRows({
              code:  "sysio.epoch",
              scope: "sysio.epoch",
              table: "epochstate",
              limit: 1
            })
            const rows = result.rows ?? []
            if (rows.length === 0) return false
            // WIREClient.getTableRows now auto-unwraps the v6 KV
            // `{key, value}` envelope, so the fields are at the top level.
            const groups = (rows[0] as any).batch_op_groups ?? []
            return groups.some(
              (members: string[]) =>
                Array.isArray(members) && members.includes(FRESH_OP_NAME)
            )
          } catch (err) {
            log.warn(`[flow-batch-operator-termination] epochstate read failed: ${err}`)
            return false
          }
        },
        TEST_EPOCH_DURATION_SEC * 5 * MsPerSecond,
        LongPollIntervalMs
      )
    },
    TEST_EPOCH_DURATION_SEC * 5 * MsPerSecond + PollDeadlineBufferMs
  )

  // ── No nodeop runs for batchop.fresh → recorddel buffer accumulates misses ──

  test(
    "after miss accumulation window, batchop.fresh status flips to TERMINATED",
    async () => {
      // With batchop.fresh in rotation but no SBP running for it, every
      // epoch that schedules its group records `delivered=false` against
      // it. `terminate_max_consecutive_misses=2` means 2 consecutive
      // missed scheduled-epochs (one per chain, so each scheduled epoch
      // contributes 2 missed-delivery records — one per outpost).
      // Wait long enough for the rolling-window evaluation in termcheck
      // to fire.
      await pollUntil(
        `${FRESH_OP_NAME} status flips to TERMINATED`,
        async () => {
          const { rows } = await ctx.wireClient.getOperators()
          const op       = rows.find((o: any) => o.account === FRESH_OP_NAME)
          return op != null && isStatus(op.status, OperatorStatus.TERMINATED)
        },
        TEST_EPOCH_DURATION_SEC * MissAccumulationEpochs * MsPerSecond,
        LongPollIntervalMs
      )
    },
    TEST_EPOCH_DURATION_SEC * MissAccumulationEpochs * MsPerSecond + PollDeadlineBufferMs
  )

  test(
    "terminated_at>0 and status_reason populated on batchop.fresh row",
    async () => {
      const { rows } = await ctx.wireClient.getOperators()
      const fresh    = rows.find((op: any) => op.account === FRESH_OP_NAME)
      expect(fresh).toBeDefined()
      expect(isStatus(fresh.status, OperatorStatus.TERMINATED)).toBe(true)
      expect(Number(fresh.terminated_at)).toBeGreaterThan(0)
      expect(typeof fresh.status_reason).toBe("string")
      expect(fresh.status_reason.length).toBeGreaterThan(0)
    },
    30_000
  )

  // ── WITHDRAW_REMIT envelopes emitted on both outposts ──

  test(
    "depot emits OPERATOR_ACTION(WITHDRAW_REMIT) for both ETH and SOL bonds",
    async () => {
      // The depot's `sysio.opreg::flushwtdw` flow:
      //   1. Walks `wtdwqueue` for matured rows
      //   2. Calls `emit_withdraw_remit(...)` → queues OPERATOR_ACTION on
      //      msgch (transient — the row is drained when `buildenv` packs
      //      it into the next outbound envelope, per `evalcons`'s inline
      //      cleanup), then
      //   3. Calls `append_action_log(ops, op_pk, remit_action, true, "")`
      //      — PERMANENT audit entry on the operator's `recent_actions`
      //      ring buffer (`sysio.opreg::operators[freshop].recent_actions`).
      //
      // The msgch.attestations table can't be the source of truth here
      // because of the inline cleanup; `recent_actions` is the permanent
      // record. Assert that freshop's recent_actions contains a
      // success-true WITHDRAW_REMIT entry for BOTH ETH and SOL chains.
      // The per-chain entries land independently as `flushwtdw` walks the
      // wtdwqueue (one row per (account, chain, token_kind)).
      await pollUntil(
        "freshop.recent_actions contains success-true WITHDRAW_REMIT for both ETH and SOL",
        async () => {
          const { rows } = await ctx.wireClient.getOperators()
          const op = rows.find((o: any) => o.account === FRESH_OP_NAME)
          if (!op) return false
          const remits = (op.recent_actions ?? []).filter((entry: any) => {
            const at = String(entry.action?.action_type)
            // ABI-deserialised `success` arrives as numeric `1` / `0`,
            // NOT JS boolean `true` / `false` (the chain reflects the
            // bool-as-uint8 wire shape literally). Compare to truthy
            // rather than `=== true` to match either form.
            return at === "ACTION_TYPE_WITHDRAW_REMIT" && Boolean(entry.success)
          })
          // v6: the action's chain identifier is `chain_code` (slug_name
          // uint64), not `chain` (ChainKind enum name). Compare against
          // the packed slug_name numeric value.
          const ethCodeNum = SlugName.from("ETHEREUM")
          const solCodeNum = SlugName.from("SOLANA")
          const chainCodes = new Set(
            remits.map((e: any) => Number(e.action?.chain_code ?? e.action?.chain_code?.value))
          )
          return chainCodes.has(ethCodeNum) && chainCodes.has(solCodeNum)
        },
        TEST_EPOCH_DURATION_SEC * RemitPropagationEpochs * MsPerSecond,
        LongPollIntervalMs
      )
    },
    TEST_EPOCH_DURATION_SEC * RemitPropagationEpochs * MsPerSecond + PollDeadlineBufferMs
  )

  // ── ETH outpost: depositedByKind decremented + wallet balance restored ──

  test(
    "ETH outpost: depositedByKind for fresh op returns to 0 after inbound WITHDRAW_REMIT",
    async () => {
      await pollUntil(
        "ETH OperatorRegistry.depositedByCode(freshAddr, ETH) returns to 0",
        async () => {
          // v6: depositedByKind(TokenKind) → depositedByCode(uint64 slug_name).
          const balance = await (opRegContract as any).depositedByCode(
            freshEthWallet.address,
            BigInt(SlugName.from("ETH"))
          )
          return BigInt(balance) === 0n
        },
        TEST_EPOCH_DURATION_SEC * RemitPropagationEpochs * MsPerSecond,
        LongPollIntervalMs
      )

      // Manual on-chain wallet verification — assert the EXACT bond
      // amount was credited back to freshop's ETH wallet by polling the
      // anvil RPC's `eth_getBalance` until the delta from
      // `postDepositEthWei` matches `FLOW_E_MIN_ETH_BOND` to the wei.
      // freshop signs zero transactions between deposit and remit
      // (the cranker covers gas on its own wallet for both `epochIn`
      // and any `messagesIn` follow-up), so the receiving wallet's
      // balance change is purely the `_transferOut(amount)` from
      // `_handleWithdrawRemit`. Any drift would indicate the outpost
      // applied a different amount than the depot encoded into the
      // WITHDRAW_REMIT attestation — exactly the "decoder mismatch"
      // category the no_size{} fix was supposed to close, so this
      // assertion guards the regression.
      await pollUntil(
        `freshop ETH wallet balance increased by exactly FLOW_E_MIN_ETH_BOND (${FLOW_E_MIN_ETH_BOND} wei)`,
        async () => {
          const balance = await ctx.ethProvider.getBalance(freshEthWallet.address)
          return balance - postDepositEthWei === FLOW_E_MIN_ETH_BOND
        },
        TEST_EPOCH_DURATION_SEC * RemitPropagationEpochs * MsPerSecond,
        LongPollIntervalMs
      )
    },
    TEST_EPOCH_DURATION_SEC * RemitPropagationEpochs * MsPerSecond + PollDeadlineBufferMs
  )

  // ── SOL outpost: collateral_by_kind decremented + wallet balance restored ──

  test(
    "SOL outpost: vault → operator transfer fires once cranker passes pubkey on epoch_in remaining_accounts",
    async () => {
      const sol = new SOLClient(`http://127.0.0.1:${ctx.ports.solanaRpc}`)
      // The SOL cranker (outpost_solana_client::deliver_outbound_envelope)
      // decodes inbound envelopes and appends operator pubkeys mentioned
      // in WITHDRAW_REMIT attestations to the final-chunk epoch_in's
      // remaining_accounts. The on-chain handler then debits the
      // collateral ledger AND signed-CPI transfers vault → operator.
      // After both happen, the operator's lamport balance returns to
      // ≈ pre-deposit (5e9 airdrop − 2e6 deposit + 2e6 remit − a couple
      // of tx fees ≈ 5e9).
      // Manual on-chain wallet verification — assert the EXACT bond
      // amount was credited back to freshop's SOL wallet via the
      // signed-CPI `system_program::transfer` from the outpost's vault
      // PDA. freshop signs zero transactions between deposit and remit
      // (the cranker pays tx fees for `epoch_in` on its own SOL keypair),
      // so the receiving wallet's lamport delta is purely the bond
      // amount. The handler debits `collateral_by_kind` by `amount` and
      // transfers the same `amount` to the operator — a mismatch here
      // would indicate the SOL handler is reading a different field than
      // the depot encoded.
      await pollUntil(
        `freshop SOL wallet lamport balance increased by exactly FLOW_E_MIN_SOL_BOND (${FLOW_E_MIN_SOL_BOND})`,
        async () => {
          const lamports = await solConnection.getBalance(freshSolPubkey)
          return BigInt(lamports - postDepositSolLamports) === FLOW_E_MIN_SOL_BOND
        },
        TEST_EPOCH_DURATION_SEC * RemitPropagationEpochs * MsPerSecond,
        LongPollIntervalMs
      )

      // Also verify the SOL outpost's on-chain ledger row went to zero.
      const programId = oppProgram.programId
      const [registryPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("operator_registry")],
        programId
      )
      const registryAccount =
        await (oppProgram.account as any).operatorRegistry.fetch(registryPda)
      // v6: SOL OperatorRegistry field renamed `collateral_by_kind` →
      // `collateral_by_code` (Anchor IDL camelCases to `collateralByCode`).
      // Each entry's discriminator is now a `token_code` (u64 slug_name),
      // not a `token_kind` (enum). `freshop` deposited native SOL, so
      // match against the SOL slug_name.
      const ledger = registryAccount.collateralByCode as Array<{
        depositor: PublicKey
        tokenCode: anchor.BN | number | bigint
        amount: anchor.BN
      }>
      const solCodeBig = BigInt(SlugName.from("SOL"))
      const row = ledger?.find?.(
        e => e.depositor.equals(freshSolPubkey) && BigInt(e.tokenCode.toString()) === solCodeBig
      )
      // Row may be retained at 0, or pruned — either is a valid remit
      // outcome. Assert: row absent OR amount === 0.
      if (row) {
        expect(BigInt(row.amount.toString())).toBe(0n)
      }
    },
    TEST_EPOCH_DURATION_SEC * RemitPropagationEpochs * MsPerSecond + PollDeadlineBufferMs
  )
})
