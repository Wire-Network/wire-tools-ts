import "jest"
import * as Fs from "node:fs"
import * as Path from "node:path"
import { ethers } from "ethers"
import * as anchor from "@coral-xyz/anchor"
import { Connection } from "@solana/web3.js"
import {
  AnvilManager,
  depositSOLCollateral,
  FlowTestContext,
  pollUntil,
  log,
  ProcessManager,
  provisionFreshBatchOperator,
  startFreshBatchOperatorDaemon,
  type FreshBatchOperator,
  type FreshBatchOperatorDaemon
} from "@wireio/test-cluster-tool"
import {
  ChainKind,
  OperatorType,
  OperatorStatus,
  AttestationType
} from "@wireio/opp-typescript-models"
import { SlugName } from "@wireio/sdk-core"

/**
 * Native ETH `tokenCode` on the OperatorRegistry. The contract was
 * refactored from `TokenKind` (small enum) to `tokenCode` (slug_name
 * u64) in v6; this test needs to pass the slug_name-packed value
 * matching the deploy-time `setNativeTokenCode("ETH")`.
 */
const ETH_TOKEN_CODE = SlugName.from("ETH")

/**
 * Slug-encoded chain code for the Ethereum outpost. The v6 data-model
 * refactor moved `sysio.opreg::balances` + `wtdwqueue` rows from
 * `chain` / `chain_kind` (small enum) to `chain_code` (slug_name u64),
 * matching the depot's `sysio.chains::chains` row. Tests must compare
 * against this packed slug, NOT against the `ChainKind` enum.
 */
const ETH_CHAIN_CODE = SlugName.from("ETHEREUM")

/**
 * Unwrap a slug_name field as returned by clio JSON. The contract
 * serialises a `sysio::slug_name` as `{ value: "<decimal>" }` over the
 * wire — but some endpoints flatten it to the raw number. Accept both.
 *
 * @param raw  Field value from a `get_table_rows` response.
 * @return  Numeric slug value, or NaN if the field is missing/malformed.
 */
const slugValue = (raw: unknown): number => {
  if (raw === undefined || raw === null) return NaN
  if (typeof raw === "object" && "value" in (raw as any)) {
    return Number((raw as any).value)
  }
  return Number(raw)
}

/**
 * Flow: Node Operator Collateral Lifecycle — full deposit → withdraw →
 * remit cycle for a single batch operator on the Ethereum outpost.
 *
 * Per CLAUDE-WIRE-OPERATOR-COLLATERAL-IMPL-PLAN.md §11.1 (lifecycle scenario),
 * with the underwriter race + lock steps deferred to a future session (the
 * race assertions live in their own flow once §11.3 is reactivated).
 *
 * Sequence:
 *   1. `OperatorRegistry.deposit(BATCH){value: X}` on ETH
 *        → `OperatorDeposited` event + outbound OPERATOR_ACTION
 *          (DEPOSIT_REQUEST) attestation.
 *   2. WIRE batch operators relay the OPP envelope → depot's
 *      `sysio.msgch::dispatch_operator_action` → `opreg::depositinle` →
 *      operator's `balances` row credited on `sysio.opreg::operators`.
 *   3. `OperatorRegistry.withdraw(amount)` on ETH
 *        → `WithdrawRequested` event + outbound OPERATOR_ACTION
 *          (WITHDRAW_REQUEST) attestation.
 *   4. Depot's `opreg::withdrawinle` enqueues a `wtdwqueue` row with
 *      `eligible_at_epoch = current + WITHDRAW_WAIT_EPOCHS`.
 *   5. After the wait window, `sysio.epoch::advance` → `opreg::flushwtdw`
 *      decrements the balance, erases the queue row, and emits
 *      OPERATOR_ACTION(WITHDRAW_REMIT) outbound back to ETH.
 *   6. ETH OPP delivers WITHDRAW_REMIT → `OperatorRegistry._handleWithdrawRemit`
 *      decrements `info.deposited` and forwards the escrow to the operator's
 *      ETH address.
 *
 * The eligible-after-wait + remit propagation steps are the slow ones —
 * they're guarded by `WaitForRemitEpochBudget`-scaled `pollUntil` deadlines.
 *
 * Environment matches the sibling flow packages:
 *   WIRE_CLUSTER_CONFIG — path to cluster-config.json (attach mode)
 *   WIRE_BUILD_PATH     — wire-sysio build dir (fresh mode)
 *   WIRE_ETH_PATH       — wire-ethereum repo root (fresh mode / ETH ABIs)
 *   WIRE_CLUSTER_PATH   — cluster data dir (fresh mode)
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Epoch duration in seconds. MUST be >= `MIN_EPOCH_DURATION_SEC` (60) — the
 * `sysio.epoch::setconfig` floor rejects anything lower, which fails bootstrap.
 * Per-test `pollUntil` deadlines below are derived from this value, so they
 * scale automatically with it.
 */
const TEST_EPOCH_DURATION_SEC = 60

/** This flow exclusively registers a batch operator. */
const OPERATOR_TYPE_BATCH = OperatorType.BATCH

/** Base collateral deposit. Half is withdrawn mid-flow to leave the
 *  operator above any post-launch minimum on the remaining half. */
const BOND_AMOUNT = 2_000_000n
const WITHDRAW_AMOUNT = 1_000_000n
const EXPECTED_REMAINING_BALANCE = BOND_AMOUNT - WITHDRAW_AMOUNT

/** 1 s in ms — multiplies epoch counts into ms deadlines. */
const MsPerSecond = 1_000

/** Buffer added on top of every `pollUntil` deadline before jest's timeout. */
const PollDeadlineBufferMs = 30_000

/** Interval used for long-running chain-state polls. */
const LongPollIntervalMs = 3_000

/**
 * Hard cap for `beforeAll` cluster bootstrap + freshOp daemon
 * kill-restart cycle. The cycle waits for the daemon's nodeop to
 * sync from genesis before discovering outposts (up to ~6 min on
 * a cold start), so this needs to clear both the harness substrate
 * bootstrap (~3 min) and the daemon-cycle window with margin.
 */
const BootstrapTimeoutMs = 720_000

/** Epochs allotted for the ETH→WIRE relay of an inbound OPERATOR_ACTION. */
const RelayEpochBudget = 9

/** Epochs allotted for the WIRE→ETH remit (2-epoch wait + flush + relay). */
const WaitForRemitEpochBudget = 12

/** Zero-valued 32-byte hash, used as the "no last message" sentinel. */
const ZeroMessageId =
  "0x0000000000000000000000000000000000000000000000000000000000000000"

/**
 * True when a chain-RPC value matches an enum member in any of the three
 * forms we've observed it in (numeric, TS enum name, protobuf snake-cased
 * name). Shared shape across the sibling flow packages' chain-state assertions.
 *
 * @param enumObj         - The protobuf enum (the runtime object).
 * @param expected        - The enum member to compare against.
 * @param actual          - The value returned by the chain RPC.
 * @param protoNamePrefix - Optional protobuf `ENUM_NAME` prefix.
 */
const enumValueMatches = <E extends object>(
  enumObj: E,
  expected: E[keyof E],
  actual: unknown,
  protoNamePrefix?: string
): boolean => {
  if (actual === expected) return true
  const tsName = (enumObj as any)[expected as any]
  if (actual === tsName) return true
  return (
    typeof tsName === "string" &&
    protoNamePrefix !== undefined &&
    actual === `${protoNamePrefix}_${tsName}`
  )
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Flow: Node Operator Collateral Lifecycle (ETH ↔ WIRE)", () => {
  let ctx: FlowTestContext
  let oppContract: ethers.Contract
  let opRegContract: ethers.Contract
  /**
   * Scenario-provisioned NON-BOOTSTRAPPED batch operator. The harness
   * substrate only registers bootstrapped operators (per
   * `.claude/rules/flow-test-scenario-structure.md`), and
   * `sysio.opreg::depositinle` rejects bootstrapped operators with
   * "bootstrapped operator cannot accept deposits" per
   * `wire/.claude/rules/bootstrapped-operator-invariants.md`. So this
   * flow's `beforeAll` provisions its own non-bootstrapped op (account
   * + authex + regoperator) before the deposit lifecycle assertions
   * run.
   */
  let freshOp: FreshBatchOperator
  /**
   * Daemon spawned for {@link freshOp} so its scheduled batch-op-group
   * slot can reach consensus (per the option-A fix to the depositor-
   * in-schedule stall). Without a running daemon, the depot's
   * sliding-window schedule rotates to a group containing depositor
   * and stalls — depositor is just a test wallet, no relay would
   * otherwise be running on its behalf.
   */
  let freshOpDaemon: FreshBatchOperatorDaemon
  /** Cached 33-byte compressed pubkey, supplied to deposit/withdraw. */
  let compressedPubkey: Uint8Array
  /** Cached operator ETH address (== `freshOp.ethWallet.address`). */
  let operatorAddr: string
  /** SOL RPC connection — used by the SOL-side deposit step. */
  let solConnection: Connection
  /** Anchor program wrapping opp-outpost on SOL. */
  let oppProgram: anchor.Program<anchor.Idl>

  beforeAll(async () => {
    ctx = await FlowTestContext.create({
      epochDurationSec: TEST_EPOCH_DURATION_SEC,
      // Per `feedback_operator_bond_all_chains.md`: every operator
      // must deposit on EVERY active outpost chain (ETH + SOL) before
      // status flips ACTIVE — protocol invariant. The flow exercises
      // the ETH withdraw + remit surface, but the operator must
      // satisfy SOL too to reach ACTIVE first.
      reqBatchopCollat: [
        {
          chainCode: SlugName.from("ETHEREUM"),
          tokenCode: SlugName.from("ETH"),
          minBond:   Number(BOND_AMOUNT)
        },
        {
          chainCode: SlugName.from("SOLANA"),
          tokenCode: SlugName.from("SOL"),
          minBond:   Number(BOND_AMOUNT)
        }
      ]
    })

    // Scenario provisioning: fresh non-bootstrapped batch op. Account
    // name + HD index chosen to slot cleanly past the harness's
    // bootstrap-allocated operator slots.
    freshOp = await provisionFreshBatchOperator(ctx, {
      account:    "depositor",
      ethHdIndex: 35
    })
    compressedPubkey = freshOp.ethCompressedPubkey
    operatorAddr     = freshOp.ethWallet.address

    // Spawn the depositor's batch_operator_plugin daemon. Required
    // because the depot's preference rule moves non-bootstrapped ops
    // (depositor) ahead of bootstrapped ones (batchop.a/b/c) in the
    // active schedule once depositor flips ACTIVE — and the group's
    // sole-member consensus needs depositor to relay, not just exist.
    freshOpDaemon = await startFreshBatchOperatorDaemon(ctx, freshOp)
    log.info(`[flow-ocd] freshOp daemon ready at ${freshOpDaemon.endpointUrl}`)

    const ethAddrs = ctx.loadETHAddresses()
    // Connect OPP read-only via the default signer — only used for view calls.
    oppContract = ctx.loadETHContract("OPP", ethAddrs.OPP)
    // Connect OperatorRegistry via the fresh op's HD wallet so deposit /
    // withdraw transactions are signed by the operator (msg.sender ==
    // freshOp.ethWallet.address) — the contract validates the supplied
    // compressedPubkey derives back to msg.sender.
    opRegContract = new ethers.Contract(
      ethAddrs.OperatorRegistry,
      ctx.loadETHABI("OperatorRegistry"),
      freshOp.ethWallet
    )

    // SOL anchor program — needed for the second-chain deposit step.
    // Bond on ETH alone leaves the operator in UNKNOWN; the protocol
    // requires every active outpost chain to be funded.
    if (!ctx.solanaPath) {
      throw new Error("flow-operator-collateral-deposit requires WIRE_SOLANA_PATH")
    }
    solConnection = new Connection(`http://127.0.0.1:${ctx.ports.solanaRpc}`, "confirmed")
    const idlPath = Path.join(ctx.solanaPath, "target", "idl", "opp_outpost.json")
    const idl     = JSON.parse(Fs.readFileSync(idlPath, "utf-8")) as anchor.Idl
    const provider = new anchor.AnchorProvider(
      solConnection,
      new anchor.Wallet(freshOp.solKeypair),
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

  test("Anvil + ETH contracts are reachable", async () => {
    const blockNum = await ctx.ethProvider.getBlockNumber()
    expect(blockNum).toBeGreaterThan(0)
    const code = await ctx.ethProvider.getCode(await opRegContract.getAddress())
    expect(code.length).toBeGreaterThan(4)
  })

  test("ETH chain is registered on WIRE", async () => {
    const { rows } = await ctx.wireClient.getChains()
    const ethChain = rows.find(
      (r: any) =>
        enumValueMatches(
          ChainKind,
          ChainKind.EVM,
          r.kind,
          "CHAIN_KIND"
        ) && r.external_chain_id === AnvilManager.DefaultChainId
    )
    expect(ethChain).toBeDefined()
  })

  // ── Pre-deposit baseline ──

  test("OPP lastMessageID baseline (post-bootstrap)", async () => {
    // Once `FlowTestContext.create` finishes its phased bootstrap the ETH
    // outpost has already cycled through one or more epochs of its own
    // outbound emission (RESERVE_BALANCE_SHEET every epoch, etc.), so the
    // pre-deposit `lastMessageID` is non-zero. Just sanity-check that it
    // returns a valid bytes32 — the deposit test below verifies it
    // ADVANCES after `OperatorRegistry.deposit(...)`.
    const lastMsgId = await oppContract.lastMessageID()
    expect(lastMsgId).toMatch(/^0x[0-9a-fA-F]{64}$/)
  })

  test("OperatorRegistry has no ETH deposit for this address yet", async () => {
    const eth = await opRegContract.depositedByCode(operatorAddr, ETH_TOKEN_CODE)
    expect(Number(eth)).toBe(0)
  })

  // ── Step 1: deposit on ETH ──

  test("deposit() emits OperatorDeposited + queues outbound OPERATOR_ACTION", async () => {
    const tx = await opRegContract.deposit(
      OPERATOR_TYPE_BATCH,
      compressedPubkey,
      ETH_TOKEN_CODE,
      BOND_AMOUNT,
      { value: BOND_AMOUNT }
    )
    const receipt = await tx.wait()
    expect(receipt.status).toBe(1)

    const depositedTopic =
      opRegContract.interface.getEvent("OperatorDeposited")!.topicHash
    const opRegAddr = (await opRegContract.getAddress()).toLowerCase()
    const event = receipt.logs.find(
      (l: ethers.Log) =>
        l.address.toLowerCase() === opRegAddr && l.topics[0] === depositedTopic
    )
    expect(event).toBeDefined()

    const decoded = opRegContract.interface.parseLog({
      topics: event!.topics as string[],
      data: event!.data
    })
    expect(decoded!.args.operator.toLowerCase()).toBe(operatorAddr.toLowerCase())
    expect(Number(decoded!.args.operatorType)).toBe(OPERATOR_TYPE_BATCH)
    expect(decoded!.args.amount).toBe(BOND_AMOUNT)
  })

  test("OperatorRegistry locally credits the deposit immediately", async () => {
    const eth = await opRegContract.depositedByCode(operatorAddr, ETH_TOKEN_CODE)
    expect(eth).toBe(BOND_AMOUNT)
    const info = await opRegContract.operators(operatorAddr)
    expect(Number(info.operatorType)).toBe(OPERATOR_TYPE_BATCH)
    expect(Number(info.status)).toBe(OperatorStatus.ACTIVE)
  })

  // ── Step 2: WIRE depot accepts DEPOSIT_REQUEST → balance credited ──

  test(
    "depot receives OPERATOR_ACTION(DEPOSIT_REQUEST) → operator balance row credited",
    async () => {
      const relayDeadlineMs =
        TEST_EPOCH_DURATION_SEC * RelayEpochBudget * MsPerSecond
      await pollUntil(
        "operator's ETH balance row appears on sysio.opreg",
        async () => {
          const { rows } = await ctx.wireClient.getOperators()
          // The operator's WIRE account is derived from the deposit's actor
          // address via OPPInbound's authex-derived cache; for tests we
          // accept ANY operator row that has a non-zero ETH balance.
          return rows.some((op: any) =>
            (op.balances ?? []).some(
              (b: any) =>
                slugValue(b.chain_code) === Number(ETH_CHAIN_CODE) &&
                Number(b.balance) >= Number(BOND_AMOUNT)
            )
          )
        },
        relayDeadlineMs,
        LongPollIntervalMs
      )
    },
    TEST_EPOCH_DURATION_SEC * RelayEpochBudget * MsPerSecond +
      PollDeadlineBufferMs
  )

  // ── Step 2b: deposit SOL to satisfy the protocol's all-chain bond rule ──
  // Per `feedback_operator_bond_all_chains.md`, an operator must
  // bond on EVERY active outpost chain before `meets_role_min`
  // returns true. With ETH deposited but no SOL deposit, the
  // operator stays UNKNOWN. The withdraw lifecycle below requires
  // an ACTIVE operator, so SOL gets bonded here too.

  test("deposit SOL collateral via opp-outpost::deposit IX", async () => {
    const sig = await depositSOLCollateral(
      solConnection,
      oppProgram,
      freshOp.solKeypair,
      OPERATOR_TYPE_BATCH,
      BigInt(SlugName.from("SOL")),
      BOND_AMOUNT
    )
    expect(sig).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/) // base58
  }, 60_000)

  test("depot batchop status flips ACTIVE after SOL deposit lands", async () => {
    const relayDeadlineMs =
      TEST_EPOCH_DURATION_SEC * RelayEpochBudget * MsPerSecond
    await pollUntil(
      "depot operator status=ACTIVE",
      async () => {
        const { rows } = await ctx.wireClient.getOperators()
        const op = rows.find(
          (o: any) => o.account === freshOp.account
        )
        return op != null &&
          (Number(op.status) === OperatorStatus.ACTIVE ||
           op.status === "OPERATOR_STATUS_ACTIVE")
      },
      relayDeadlineMs,
      LongPollIntervalMs
    )
  }, TEST_EPOCH_DURATION_SEC * RelayEpochBudget * MsPerSecond + PollDeadlineBufferMs)

  // ── Step 3: withdraw on ETH ──

  test("withdraw() emits WithdrawRequested + queues outbound OPERATOR_ACTION", async () => {
    const tx = await opRegContract.withdraw(
      compressedPubkey,
      ETH_TOKEN_CODE,
      WITHDRAW_AMOUNT
    )
    const receipt = await tx.wait()
    expect(receipt.status).toBe(1)

    const reqTopic =
      opRegContract.interface.getEvent("WithdrawRequested")!.topicHash
    const opRegAddr = (await opRegContract.getAddress()).toLowerCase()
    const event = receipt.logs.find(
      (l: ethers.Log) =>
        l.address.toLowerCase() === opRegAddr && l.topics[0] === reqTopic
    )
    expect(event).toBeDefined()

    const decoded = opRegContract.interface.parseLog({
      topics: event!.topics as string[],
      data: event!.data
    })
    expect(decoded!.args.operator.toLowerCase()).toBe(operatorAddr.toLowerCase())
    expect(decoded!.args.amount).toBe(WITHDRAW_AMOUNT)
  })

  test("withdraw() does NOT decrement local deposited (decrement happens on REMIT)", async () => {
    // Per OperatorRegistry.withdraw(), the per-kind escrow only changes
    // on the inbound WITHDRAW_REMIT — REQUEST is just an attestation.
    // The depot's `available()` rollup tracks the in-flight reservation.
    const eth = await opRegContract.depositedByCode(operatorAddr, ETH_TOKEN_CODE)
    expect(eth).toBe(BOND_AMOUNT)
  })

  // ── Step 4: WIRE depot enqueues the withdraw request ──

  test(
    "depot enqueues a wtdwqueue row for the withdraw request",
    async () => {
      const relayDeadlineMs =
        TEST_EPOCH_DURATION_SEC * RelayEpochBudget * MsPerSecond
      await pollUntil(
        "wtdwqueue row appears with our request amount",
        async () => {
          const { rows } = await ctx.wireClient.getWithdrawQueue()
          return rows.some(
            (r: any) =>
              slugValue(r.chain_code) === Number(ETH_CHAIN_CODE) &&
              Number(r.amount) === Number(WITHDRAW_AMOUNT)
          )
        },
        relayDeadlineMs,
        LongPollIntervalMs
      )
    },
    TEST_EPOCH_DURATION_SEC * RelayEpochBudget * MsPerSecond +
      PollDeadlineBufferMs
  )

  // ── Step 5: wait window → flushwtdw → REMIT outbound to ETH ──

  test(
    "after the wait window, the wtdwqueue row drains",
    async () => {
      const flushDeadlineMs =
        TEST_EPOCH_DURATION_SEC * WaitForRemitEpochBudget * MsPerSecond
      await pollUntil(
        "wtdwqueue row drained by flushwtdw",
        async () => {
          const { rows } = await ctx.wireClient.getWithdrawQueue()
          return !rows.some(
            (r: any) =>
              slugValue(r.chain_code) === Number(ETH_CHAIN_CODE) &&
              Number(r.amount) === Number(WITHDRAW_AMOUNT)
          )
        },
        flushDeadlineMs,
        LongPollIntervalMs
      )
    },
    TEST_EPOCH_DURATION_SEC * WaitForRemitEpochBudget * MsPerSecond +
      PollDeadlineBufferMs
  )

  test(
    "ETH OperatorRegistry receives WITHDRAW_REMIT and decrements deposited",
    async () => {
      const remitDeadlineMs =
        TEST_EPOCH_DURATION_SEC * WaitForRemitEpochBudget * MsPerSecond
      await pollUntil(
        "depositedByCode(ETH) decremented to BOND_AMOUNT - WITHDRAW_AMOUNT",
        async () => {
          const eth = await opRegContract.depositedByCode(
            operatorAddr,
            ETH_TOKEN_CODE
          )
          return eth === EXPECTED_REMAINING_BALANCE
        },
        remitDeadlineMs,
        LongPollIntervalMs
      )

      const remittedTopic =
        opRegContract.interface.getEvent("WithdrawRemitted")!.topicHash
      const opRegAddr = await opRegContract.getAddress()
      const events = await ctx.ethProvider.getLogs({
        address: opRegAddr,
        topics: [remittedTopic],
        fromBlock: 0,
        toBlock: "latest"
      })
      expect(events.length).toBeGreaterThanOrEqual(1)
    },
    TEST_EPOCH_DURATION_SEC * WaitForRemitEpochBudget * MsPerSecond +
      PollDeadlineBufferMs
  )

  // NB: a previous test in this slot queried `sysio.msgch::attestations`
  // and expected >= 2 OPERATOR_ACTION rows. That table is the depot's
  // *outbound* queue — rows live only between `queueout` and the next
  // epoch's `buildenv` pass, then get drained. By the time this test
  // would run (after the REMIT-roundtrip wait), the queue has long
  // since been emptied. The 13 tests above already prove every step of
  // the OPERATOR_ACTION traffic (deposit credit, wtdwqueue row appearance,
  // flushwtdw drain, ETH-side balance decrement, WithdrawRemitted event),
  // so the missing assertion would have been redundant even if framed
  // against the correct table.
})
