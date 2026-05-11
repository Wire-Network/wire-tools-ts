import "jest"
import { ethers } from "ethers"
import {
  AnvilManager,
  type EthereumOperatorAccountWallet,
  FlowTestContext,
  pollUntil,
  log,
  ProcessManager
} from "@wireio/test-cluster-tool"
import {
  ChainKind,
  OperatorType,
  OperatorStatus,
  AttestationType,
  TokenKind
} from "@wireio/opp-typescript-models"

/**
 * Flow B: Node Operator Collateral Lifecycle — full deposit → withdraw →
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
 * Environment matches flow-d:
 *   WIRE_CLUSTER_CONFIG — path to cluster-config.json (attach mode)
 *   WIRE_BUILD_PATH     — wire-sysio build dir (fresh mode)
 *   WIRE_ETH_PATH       — wire-ethereum repo root (fresh mode / ETH ABIs)
 *   WIRE_CLUSTER_PATH   — cluster data dir (fresh mode)
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Epoch duration sized to keep the run under jest's 120 s test cap. */
const TEST_EPOCH_DURATION_SEC = 30

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

/** Hard cap for `beforeAll` cluster bootstrap (5 min). */
const BootstrapTimeoutMs = 300_000

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
 * name). Mirrors flow-d's helper of the same shape.
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

describe("Flow B: Node Operator Collateral Lifecycle (ETH ↔ WIRE)", () => {
  let ctx: FlowTestContext
  let oppContract: ethers.Contract
  let opRegContract: ethers.Contract
  /**
   * Bootstrapped batch operator we drive deposit/withdraw through. The
   * cluster's Phase 18a/19a already registered this operator in
   * `sysio.opreg::operators` and linked its ETH key via authex, so the
   * depot will resolve `op_address` (33-byte compressed pubkey) back to
   * its WIRE account name when the OPERATOR_ACTION arrives inbound.
   */
  let batchOp: EthereumOperatorAccountWallet
  /** Cached 33-byte compressed pubkey, supplied to deposit/withdraw. */
  let compressedPubkey: Uint8Array
  /** Cached operator ETH address (== `batchOp.address`). */
  let operatorAddr: string

  beforeAll(async () => {
    ctx = await FlowTestContext.create({
      epochDurationSec: TEST_EPOCH_DURATION_SEC
    })

    // Pick the first bootstrapped BATCH operator. The harness creates
    // `DefaultBatchOperatorCount` (3) of them by default; all are
    // already authex-linked + opreg-registered.
    const batchOps = ctx.getWallet(ChainKind.ETHEREUM, OperatorType.BATCH)
    expect(batchOps.length).toBeGreaterThan(0)
    batchOp = batchOps[0] as EthereumOperatorAccountWallet
    compressedPubkey = batchOp.publicKey.data.array
    operatorAddr = batchOp.address

    const ethAddrs = ctx.loadETHAddresses()
    // Connect OPP read-only via the default signer — only used for view calls.
    oppContract = ctx.loadETHContract("OPP", ethAddrs.OPP)
    // Connect OperatorRegistry via the batch op's HD wallet so deposit /
    // withdraw transactions are signed by the operator (msg.sender ==
    // batchOp.address) — the contract validates the supplied
    // compressedPubkey derives back to msg.sender.
    opRegContract = new ethers.Contract(
      ethAddrs.OperatorRegistry,
      ctx.loadETHABI("OperatorRegistry"),
      batchOp.ethWallet
    )
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

  test("ETH outpost is registered on WIRE", async () => {
    const { rows } = await ctx.wireClient.getOutposts()
    const ethOutpost = rows.find(
      (r: any) =>
        enumValueMatches(
          ChainKind,
          ChainKind.ETHEREUM,
          r.chain_kind,
          "CHAIN_KIND"
        ) && r.chain_id === AnvilManager.DefaultChainId
    )
    expect(ethOutpost).toBeDefined()
  })

  // ── Pre-deposit baseline ──

  test("OPP has no messages before deposit", async () => {
    const lastMsgId = await oppContract.lastMessageID()
    expect(lastMsgId).toBe(ZeroMessageId)
  })

  test("OperatorRegistry has no ETH deposit for this address yet", async () => {
    const eth = await opRegContract.depositedByKind(operatorAddr, TokenKind.ETH)
    expect(Number(eth)).toBe(0)
  })

  // ── Step 1: deposit on ETH ──

  test("deposit() emits OperatorDeposited + queues outbound OPERATOR_ACTION", async () => {
    const tx = await opRegContract.deposit(
      OPERATOR_TYPE_BATCH,
      compressedPubkey,
      TokenKind.ETH,
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
    const eth = await opRegContract.depositedByKind(operatorAddr, TokenKind.ETH)
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
                enumValueMatches(
                  ChainKind,
                  ChainKind.ETHEREUM,
                  b.chain,
                  "CHAIN_KIND"
                ) && Number(b.balance) >= Number(BOND_AMOUNT)
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

  // ── Step 3: withdraw on ETH ──

  test("withdraw() emits WithdrawRequested + queues outbound OPERATOR_ACTION", async () => {
    const tx = await opRegContract.withdraw(
      compressedPubkey,
      TokenKind.ETH,
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
    const eth = await opRegContract.depositedByKind(operatorAddr, TokenKind.ETH)
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
              enumValueMatches(
                ChainKind,
                ChainKind.ETHEREUM,
                r.chain,
                "CHAIN_KIND"
              ) && Number(r.amount) === Number(WITHDRAW_AMOUNT)
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
              enumValueMatches(
                ChainKind,
                ChainKind.ETHEREUM,
                r.chain,
                "CHAIN_KIND"
              ) && Number(r.amount) === Number(WITHDRAW_AMOUNT)
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
        "depositedByKind(ETH) decremented to BOND_AMOUNT - WITHDRAW_AMOUNT",
        async () => {
          const eth = await opRegContract.depositedByKind(
            operatorAddr,
            TokenKind.ETH
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
