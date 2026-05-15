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
  KeyType,
  PrivateKey,
  SystemContracts
} from "@wireio/sdk-core"
import {
  createAuthExLink,
  depositETHCollateral,
  depositSOLCollateral,
  ETHBootstrapper,
  FlowTestContext,
  log,
  pollUntil,
  ProcessManager,
  SOLClient
} from "@wireio/test-cluster-tool"

/**
 * Flow E: Termination via Delivery Underperformance — multi-chain bond.
 *
 * Verifies the full protocol promise that an operator becomes ACTIVE only
 * after posting required collateral on **every active outpost**, and on
 * termination the bonded collateral is remitted back from every outpost's
 * vault. The previous flow-e used a bootstrapped operator (`batchop.a`,
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
 *  flow-e config (batchOperatorCount=9, underwriterCount default=1)
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
const DEV_K1_PUBLIC_KEY = "SYS6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV"
const BOOTSTRAP_NODE_OWNER = "defproducera"

const ANVIL_MNEMONIC = ETHBootstrapper.AnvilMnemonic
const ANVIL_DERIVATION_PATH = ETHBootstrapper.DerivationPath

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

describe("Flow E: Termination via miss-window (non-bootstrapped op, two-chain bond)", () => {
  let ctx: FlowTestContext
  let opRegContract: ethers.Contract
  let opRegAddress: string

  // The fresh op's identities — populated in step 2 (post-bootstrap).
  let freshEthWallet: ethers.HDNodeWallet
  let freshEthPubkey33: Uint8Array
  let freshSolKeypair: Keypair
  let freshSolPubkey: PublicKey

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
        { chain: ChainKind.ETHEREUM, tokenKind: TokenKind.ETH, minBond: FLOW_E_REQ_ETH_MIN_BOND },
        { chain: ChainKind.SOLANA,   tokenKind: TokenKind.SOL, minBond: FLOW_E_REQ_SOL_MIN_BOND }
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
      throw new Error("flow-e requires WIRE_SOLANA_PATH so the harness can load opp_outpost IDL")
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

  // ── Create batchop.fresh: account + authex links + regoperator ──

  test(
    "create batchop.fresh account, ETH+SOL authex links, regoperator(non-bootstrapped)",
    async () => {
      // 0) Bootstrap leaves the wallet closed/locked for security; re-open
      // + unlock so signed actions below (createAccount, createlink,
      // addpolicy) can complete with `clio` resolving the dev K1 key.
      await ctx.wireClient.clio.walletOpenAndUnlock("default")

      // 1) Account.
      try {
        await ctx.wireClient.clio.createAccount(
          "sysio",
          FRESH_OP_NAME,
          DEV_K1_PUBLIC_KEY,
          DEV_K1_PUBLIC_KEY
        )
      } catch (err: any) {
        if (!(err?.message ?? "").includes("already exists")) {
          throw new Error(`Failed to create ${FRESH_OP_NAME}: ${err?.message ?? err}`)
        }
      }

      // 2) Resource policy from the bootstrap node owner — same flow the
      // harness uses internally for every operator account. The `_weight`
      // fields are sysio.token assets ("25.0000 SYS"), NOT raw integers
      // — the strongly-typed generic enforces that at compile time per
      // `feedback_strongly_typed_contract_actions.md`.
      await ctx.wireClient.clio.pushActionAndWait<SystemContracts.SysioRoaAddpolicyAction>(
        "sysio.roa",
        "addpolicy",
        {
          owner:        FRESH_OP_NAME,
          issuer:       BOOTSTRAP_NODE_OWNER,
          net_weight:   "25.0000 SYS",
          ram_weight:   "25.0000 SYS",
          cpu_weight:   "25.0000 SYS",
          time_block:   0,
          network_gen:  0
        },
        `${BOOTSTRAP_NODE_OWNER}@active`
      )

      // 3) ETH wallet — HD-derive at slot one past the 9 bootstrapped batchops.
      const mnemonic = ethers.Mnemonic.fromPhrase(ANVIL_MNEMONIC)
      freshEthWallet = ethers.HDNodeWallet.fromMnemonic(
        mnemonic,
        `${ANVIL_DERIVATION_PATH}${FRESH_OP_HD_INDEX}`
      ).connect(ctx.ethProvider)
      // 33-byte compressed pubkey for the OperatorRegistry.deposit call +
      // for the authex link the depot indexes on bypubkey.
      const compressedHex = ethers.SigningKey.computePublicKey(
        freshEthWallet.publicKey,
        /*compressed=*/ true
      )
      freshEthPubkey33 = ethers.getBytes(
        compressedHex.startsWith("0x") ? compressedHex : `0x${compressedHex}`
      )

      // 4) SOL keypair — random ED25519, no mnemonic derivation needed.
      const solSdkKey = PrivateKey.generate(KeyType.ED)
      freshSolKeypair = Keypair.fromSecretKey(solSdkKey.data.array)
      freshSolPubkey  = freshSolKeypair.publicKey
      // Fund the SOL keypair with enough lamports to cover the deposit
      // + a handful of tx fees. The test-validator's airdrop is gated
      // at 100 SOL = 100e9 lamports — well above our 2e6-lamport deposit.
      //
      // `Connection.confirmTransaction` uses a WS-subscription confirm
      // strategy by default; the test-validator's WS port is unavailable
      // (`Unexpected server response: 404`), so the WS path hangs the
      // full 30s timeout window. Pattern matches `SOLBootstrap.
      // initializePDAs` — poll `getSignatureStatus` against a deadline.
      const airdropSig = await solConnection.requestAirdrop(freshSolPubkey, 5_000_000_000)
      const airdropDeadlineMs = Date.now() + 30_000
      while (Date.now() < airdropDeadlineMs) {
        const status = await solConnection.getSignatureStatus(airdropSig)
        const conf   = status?.value?.confirmationStatus
        if (conf === "confirmed" || conf === "finalized") break
        if (status?.value?.err) {
          throw new Error(`Airdrop tx failed: ${JSON.stringify(status.value.err)}`)
        }
        await new Promise(resolve => setTimeout(resolve, 500))
      }
      const finalBalance = await solConnection.getBalance(freshSolPubkey)
      expect(finalBalance).toBeGreaterThanOrEqual(5_000_000_000)

      // 5) Authex link for ETH — signs with the operator's secp256k1 key.
      const emPriv = PrivateKey.regenerate(
        KeyType.EM,
        Bytes.fromString(
          freshEthWallet.privateKey.startsWith("0x")
            ? freshEthWallet.privateKey.slice(2)
            : freshEthWallet.privateKey,
          "hex"
        )
      )
      await createAuthExLink(ctx.wireClient.clio, {
        chainKind:  ChainKind.ETHEREUM,
        account:    FRESH_OP_NAME,
        privateKey: emPriv,
        ethWallet:  freshEthWallet
      })

      // 6) Authex link for SOL — signs with ED25519.
      await createAuthExLink(ctx.wireClient.clio, {
        chainKind:  ChainKind.SOLANA,
        account:    FRESH_OP_NAME,
        privateKey: solSdkKey
      })

      // 7) regoperator(is_bootstrapped=false). Signed as opreg so the
      // authex-link check at lines 132-144 of sysio.opreg.cpp is
      // bypassed via has_auth(get_self()) (we created the links above
      // for the deposit-path's bypubkey index, not because regoperator
      // would otherwise reject).
      await ctx.wireClient.clio.pushActionAndWait<SystemContracts.SysioOpregRegoperatorAction>(
        "sysio.opreg",
        "regoperator",
        {
          account:         FRESH_OP_NAME,
          type:            SystemContracts.SysioOpregOperatortype.OPERATOR_TYPE_BATCH,
          is_bootstrapped: false
        },
        "sysio.opreg@active"
      )

      // Post-condition: operator row exists with status=UNKNOWN (no
      // deposits yet — meets_role_min iterates req_batchop_collat and
      // every available(...) returns 0).
      const { rows } = await ctx.wireClient.getOperators()
      const fresh    = rows.find((op: any) => op.account === FRESH_OP_NAME)
      expect(fresh).toBeDefined()
      expect(isStatus(fresh.status, OperatorStatus.UNKNOWN)).toBe(true)
    },
    60_000
  )

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
          tokenKind: number,
          amount: bigint,
          overrides?: ethers.Overrides & { value?: bigint }
        ) => Promise<ethers.ContractTransactionResponse>
      }
      await depositETHCollateral(
        opReg,
        OperatorType.BATCH,
        freshEthPubkey33,
        TokenKind.ETH,
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
          const balances = op.balances ?? []
          const ethRow   = balances.find(
            (b: any) =>
              (typeof b.chain === "number" ? b.chain : b.chain) === ChainKind.ETHEREUM ||
              b.chain === "CHAIN_KIND_ETHEREUM"
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
        TokenKind.SOL,
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
            const groups = (rows[0] as any).batch_op_groups ?? []
            return groups.some(
              (members: string[]) =>
                Array.isArray(members) && members.includes(FRESH_OP_NAME)
            )
          } catch (err) {
            log.warn(`[flow-e] epochstate read failed: ${err}`)
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
          const chains = new Set(remits.map((e: any) => String(e.action?.chain)))
          return (
            chains.has("CHAIN_KIND_ETHEREUM") &&
            chains.has("CHAIN_KIND_SOLANA")
          )
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
        "ETH OperatorRegistry.depositedByKind(freshAddr, ETH) returns to 0",
        async () => {
          const balance = await (opRegContract as any).depositedByKind(
            freshEthWallet.address,
            TokenKind.ETH
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
      const ledger = registryAccount.collateralByKind as Array<{
        depositor: PublicKey
        tokenKind: number
        amount: anchor.BN
      }>
      const row = ledger.find(
        e => e.depositor.equals(freshSolPubkey) && e.tokenKind === TokenKind.SOL
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
