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
  MessageDirection,
  TokenKind
} from "@wireio/opp-typescript-models"

/**
 * Flow: Collateral Deposit via BAR — full e2e ETH → WIRE relay.
 *
 * Supports two modes:
 *   - **Fresh** (CI/CD): creates a cluster from scratch, bootstraps, runs tests, tears down
 *   - **Attach**: connects to an already-running cluster via WIRE_CLUSTER_CONFIG
 *
 * Flow:
 *   1. BAR.bond() on ETH → OPPEnvelope event emitted immediately
 *   2. WIRE epoch advances → elected batch operators run epoch cycle
 *   3. Batch operators read OPPEnvelope events from ETH, deliver to sysio.msgch
 *   4. Message appears in WIRE's inchainreq / deliveries / messages tables
 *
 * Environment:
 *   WIRE_CLUSTER_CONFIG — path to cluster-config.json (attach mode)
 *   WIRE_BUILD_PATH     — wire-sysio build dir (fresh mode)
 *   WIRE_ETH_PATH       — wire-ethereum repo root (fresh mode / ETH ABIs)
 *   WIRE_CLUSTER_PATH   — cluster data dir (fresh mode)
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Epoch duration for this flow. Short-enough to avoid dragging out the suite,
 * long-enough that producers actually run through warmup → active.
 */
const TEST_EPOCH_DURATION_SEC = 90

/** Convenience alias — this flow exclusively registers batch operators. */
const OPERATOR_TYPE_BATCH = OperatorType.BATCH

/**
 * Collateral deposit sent to `OperatorRegistry.deposit()`. 1M base units.
 * Changing this must stay ≥ `OperatorRegistry.minimumDeposit()` — otherwise
 * the deposit transaction reverts.
 */
const BOND_AMOUNT = 1_000_000n

/** 1 s in ms — used to multiply epoch counts into poll deadlines. */
const MsPerSecond = 1_000

/** Scheduling buffer added to each `pollUntil` deadline before the jest timeout. */
const PollDeadlineBufferMs = 30_000

/** Interval used for long-running chain-state polls. */
const LongPollIntervalMs = 3_000

/** Hard cap for `beforeAll` cluster bootstrap (5 min). */
const BootstrapTimeoutMs = 300_000

/** Short-horizon `pollUntil` deadline for consensus propagation. */
const ConsensusPropagationTimeoutMs = 60_000

/** Wait budget expressed in epochs — converted to ms at use site. */
const CrankEpochBudget = 3
const RelayEpochBudget = 9

/** Zero-valued 32-byte hash used as the "no last message" sentinel. */
const ZeroMessageId =
  "0x0000000000000000000000000000000000000000000000000000000000000000"

/**
 * True when a chain-RPC value matches an enum member in any of the three
 * forms we've seen it appear in the wild.
 *
 * @param enumObj         - The protobuf enum (the runtime object).
 * @param expected        - The enum member to compare against.
 * @param actual          - The value returned by the chain RPC.
 * @param protoNamePrefix - Optional protobuf `ENUM_NAME` prefix (e.g.
 *                          `"CHAIN_KIND"`). When supplied, proto-style
 *                          upper-snake names are ALSO considered a match.
 *
 * @example
 * enumValueMatches(ChainKind, ChainKind.EVM, r.chain_kind, "CHAIN_KIND")
 * // matches 2  | "ETHEREUM"  | "CHAIN_KIND_ETHEREUM"
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

describe("Flow: Collateral Deposit via OperatorRegistry (ETH → WIRE)", () => {
  let ctx: FlowTestContext
  let oppContract: ethers.Contract
  let oppInboundContract: ethers.Contract
  let barContract: ethers.Contract
  let opRegContract: ethers.Contract
  /** Bootstrapped batch operator used to drive the deposit. */
  let batchOp: EthereumOperatorAccountWallet
  let signerAddr: string

  // ── Setup ──

  beforeAll(async () => {
    ctx = await FlowTestContext.create({
      epochDurationSec: TEST_EPOCH_DURATION_SEC
    })

    const batchOps = ctx.getWallet(ChainKind.EVM, OperatorType.BATCH)
    expect(batchOps.length).toBeGreaterThan(0)
    batchOp = batchOps[0] as EthereumOperatorAccountWallet
    signerAddr = batchOp.address

    const ethAddrs = ctx.loadETHAddresses()
    oppContract = ctx.loadETHContract("OPP", ethAddrs.OPP)
    oppInboundContract = ctx.loadETHContract("OPPInbound", ethAddrs.OPPInbound)
    barContract = ctx.loadETHContract("BAR", ethAddrs.BAR)
    // Connect OperatorRegistry via the batch op's HD wallet so deposit
    // transactions are signed by an authex-linked operator; the depot
    // resolves `op_address` → WIRE-name via the `bypubkey` index.
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

  // ── WIRE chain health ──

  test("WIRE chain is producing blocks", async () => {
    const info = await ctx.wireClient.getInfo()
    expect(Number(info.head_block_num)).toBeGreaterThan(0)
    expect(info.head_block_producer).toBeDefined()
  })

  // ── ETH health ──

  test("Anvil is running with deployed contracts", async () => {
    const blockNum = await ctx.ethProvider.getBlockNumber()
    expect(blockNum).toBeGreaterThan(0)

    const [oppCode, barCode] = await Promise.all([
      ctx.ethProvider.getCode(await oppContract.getAddress()),
      ctx.ethProvider.getCode(await barContract.getAddress())
    ])
    expect(oppCode.length).toBeGreaterThan(4)
    expect(barCode.length).toBeGreaterThan(4)
  })

  test("OPP contract is accessible on ETH", async () => {
    const epochIndex = await oppContract.epochIndex()
    expect(epochIndex).toBeDefined()
  })

  test("BAR contract is accessible on ETH", async () => {
    const attestationType = await barContract.NODE_OWNER_REG_ATTESTATION()
    expect(Number(attestationType)).toBe(AttestationType.NODE_OWNER_REG)
  })

  test("OperatorRegistry contract is accessible on ETH", async () => {
    const attestationType = await opRegContract.OPERATOR_ACTION_ATTESTATION()
    expect(Number(attestationType)).toBe(AttestationType.OPERATOR_ACTION)
  })

  // ── WIRE OPP state ──

  test("Epoch config is set on WIRE", async () => {
    const { rows } = await ctx.wireClient.getEpochConfig()
    expect(rows.length).toBe(1)
    expect(rows[0].epoch_duration_sec).toBe(TEST_EPOCH_DURATION_SEC)
    expect(rows[0].batch_operator_minimum_active).toBeGreaterThanOrEqual(3)
  })

  test("Epoch state is initialized", async () => {
    const { rows } = await ctx.wireClient.getEpochState()
    expect(rows.length).toBe(1)
    expect(rows[0].current_epoch_index).toBeGreaterThanOrEqual(0)
    expect(rows[0].batch_op_groups.length).toBe(3)
  })

  test("ETH chain is registered", async () => {
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

  test("Batch operators are AVAILABLE in opreg", async () => {
    const { rows } = await ctx.wireClient.getOperators()
    const batchOps = rows.filter((r: any) =>
      enumValueMatches(
        OperatorType,
        OperatorType.BATCH,
        r.type,
        "OPERATOR_TYPE"
      )
    )
    expect(batchOps.length).toBe(3)
    batchOps.forEach((op: any) => {
      expect(
        enumValueMatches(
          OperatorStatus,
          OperatorStatus.ACTIVE,
          op.status,
          "OPERATOR_STATUS"
        )
      ).toBe(true)
      expect(op.is_bootstrapped).toBe(1)
    })
  })

  // ── Pre-bond baseline ──

  test("OPP has no messages before bond", async () => {
    const lastMsgId = await oppContract.lastMessageID()
    expect(lastMsgId).toBe(ZeroMessageId)
  })

  test("OperatorRegistry has no deposits before test", async () => {
    const eth = await opRegContract.depositedByKind(signerAddr, TokenKind.NATIVE)
    expect(Number(eth)).toBe(0)
  })

  // ── Collateral deposit via OperatorRegistry.deposit() ──

  test("OperatorRegistry.deposit() succeeds and emits OperatorDeposited + OPPEnvelope", async () => {
    const tx = await opRegContract.deposit(
      OPERATOR_TYPE_BATCH,
      batchOp.publicKey.data.array,
      TokenKind.NATIVE,
      BOND_AMOUNT,
      { value: BOND_AMOUNT }
    )
    const receipt = await tx.wait()
    expect(receipt.status).toBe(1)

    const opRegAddr = await opRegContract.getAddress()
    const depositedTopic =
      opRegContract.interface.getEvent("OperatorDeposited")!.topicHash
    const depositEvent = receipt.logs.find(
      (l: ethers.Log) =>
        l.address.toLowerCase() === opRegAddr.toLowerCase() &&
        l.topics[0] === depositedTopic
    )
    expect(depositEvent).toBeDefined()

    const decoded = opRegContract.interface.parseLog({
      topics: depositEvent!.topics as string[],
      data: depositEvent!.data
    })
    expect(decoded!.name).toBe("OperatorDeposited")
    expect(decoded!.args.operator.toLowerCase()).toBe(signerAddr.toLowerCase())
    expect(Number(decoded!.args.operatorType)).toBe(OPERATOR_TYPE_BATCH)
    expect(decoded!.args.amount).toBe(BOND_AMOUNT)
  })

  test("Deposit is recorded in OperatorRegistry", async () => {
    const eth = await opRegContract.depositedByKind(signerAddr, TokenKind.NATIVE)
    expect(eth).toBe(BOND_AMOUNT)
    const info = await opRegContract.operators(signerAddr)
    expect(Number(info.operatorType)).toBe(OPERATOR_TYPE_BATCH)
    expect(Number(info.status)).toBe(OperatorStatus.ACTIVE)
  })

  // ── OPP message emitted on ETH ──

  test(
    "OPP emits OPPEnvelope event after crank drains queued messages",
    async () => {
      const crankDeadlineMs =
        TEST_EPOCH_DURATION_SEC * CrankEpochBudget * MsPerSecond
      await pollUntil(
        "OPPEnvelope event emitted",
        async () => {
          const events = await oppContract.queryFilter(
            oppContract.filters.OPPEnvelope(),
            0
          )
          return (
            events.filter(
              (e): e is ethers.EventLog => e instanceof ethers.EventLog
            ).length > 0
          )
        },
        crankDeadlineMs,
        LongPollIntervalMs
      )
    },
    TEST_EPOCH_DURATION_SEC * CrankEpochBudget * MsPerSecond +
      PollDeadlineBufferMs
  )

  test("OPP lastMessageID is non-zero after deposit", async () => {
    const lastMsgId = await oppContract.lastMessageID()
    expect(lastMsgId).not.toBe(ZeroMessageId)
  })

  // ── E2E relay: batch operators deliver OPPEnvelope to WIRE ──

  test(
    "Batch operators deliver envelopes to WIRE",
    async () => {
      const relayDeadlineMs =
        TEST_EPOCH_DURATION_SEC * RelayEpochBudget * MsPerSecond
      await pollUntil(
        "envelopes appear in sysio.msgch",
        async () => {
          const { rows } = await ctx.wireClient.getEnvelopes()
          return rows.length > 0
        },
        relayDeadlineMs,
        LongPollIntervalMs
      )

      const { rows: envelopes } = await ctx.wireClient.getEnvelopes()
      expect(envelopes.length).toBeGreaterThanOrEqual(1)

      envelopes.forEach((env: any) => {
        expect(env.batch_op_name).toBeDefined()
        expect(env.checksum).toBeDefined()
        expect(env.raw_data.length).toBeGreaterThan(0)
      })
    },
    TEST_EPOCH_DURATION_SEC * RelayEpochBudget * MsPerSecond +
      PollDeadlineBufferMs
  )

  test("Consensus produces inbound messages", async () => {
    const isInbound = (r: any): boolean =>
      enumValueMatches(
        MessageDirection,
        MessageDirection.INBOUND,
        r.direction,
        "MESSAGE_DIRECTION"
      )

    await pollUntil(
      "inbound messages appear after consensus",
      async () => {
        const { rows } = await ctx.wireClient.getMessages()
        return rows.some(isInbound)
      },
      ConsensusPropagationTimeoutMs,
      LongPollIntervalMs
    )

    const { rows: messages } = await ctx.wireClient.getMessages()
    const inbound = messages.filter(isInbound)
    expect(inbound.length).toBeGreaterThanOrEqual(1)
    inbound.forEach((msg: any) => {
      expect(msg.raw_payload.length).toBeGreaterThan(0)
      expect(msg.chain_code).toBeGreaterThanOrEqual(0)
    })
  })

  test("Attestations table has entries", async () => {
    const { rows: attestations } = await ctx.wireClient.getAttestations()
    expect(attestations.length).toBeGreaterThanOrEqual(1)

    const groupAtts = attestations.filter((a: any) =>
      enumValueMatches(
        AttestationType,
        AttestationType.BATCH_OPERATOR_GROUPS,
        a.type,
        "ATTESTATION_TYPE"
      )
    )
    expect(groupAtts.length).toBeGreaterThanOrEqual(1)
  })

  // ── WIRE-side state after relay ──

  test("No uwreq lock rows on WIRE (collateral deposit, not underwriting)", async () => {
    const { rows } = await ctx.wireClient.getLocks()
    expect(rows.length).toBe(0)
  })
})
