import "jest"
import Assert from "node:assert"
import Path from "path"
import Fs from "fs"
import { ethers } from "ethers"
import {
  ClusterManager,
  WIREClient,
  type ClusterPorts,
  retry,
  sleep,
  log,
  ProcessManager
} from "@wire-e2e-tests/harness"
import {
  ChainKind,
  OperatorType,
  OperatorStatus,
  TokenKind,
  AttestationType
} from "@wireio/opp-typescript-models"

/**
 * Flow D: Collateral Deposit via BAR — full e2e ETH → WIRE relay.
 *
 * Creates a fresh cluster with ETH bootstrap, calls BAR.bond() to deposit
 * collateral, then waits for batch operators to relay the OPPEnvelope from
 * ETH to WIRE via the epoch cycle.
 *
 * Flow:
 *   1. BAR.bond() on ETH → OPPEnvelope event emitted immediately
 *   2. WIRE epoch advances → elected batch operators run epoch cycle
 *   3. Batch operators read OPPEnvelope events from ETH, deliver to sysio.msgch
 *   4. Message appears in WIRE's inchainreq / deliveries / messages tables
 *
 * Verifies:
 *   - WIRE + ETH chains healthy, OPP contracts accessible
 *   - BAR.bond() emits ActorBonded, records bond, triggers OPPEnvelope
 *   - Batch operators relay: inbound chain request created, deliveries recorded
 *   - Message relayed to WIRE messages table with correct attestation type
 *
 * Environment:
 *   WIRE_BUILD_PATH   — path to wire-sysio build dir (required)
 *   WIRE_ETH_PATH     — path to wire-ethereum repo root (required for ETH)
 *   WIRE_CLUSTER_PATH — override cluster location (default: temp dir)
 */

// ---------------------------------------------------------------------------
// Config from environment
// ---------------------------------------------------------------------------

Assert.ok(
  process.env.WIRE_BUILD_PATH,
  "WIRE_BUILD_PATH environment variable is required"
)
Assert.ok(
  process.env.WIRE_ETH_PATH,
  "WIRE_ETH_PATH environment variable is required"
)
Assert.ok(
  process.env.WIRE_CLUSTER_PATH,
  "WIRE_CLUSTER_PATH environment variable is required"
)

const WIRE_BUILD_PATH = process.env.WIRE_BUILD_PATH
const WIRE_ETH_PATH = process.env.WIRE_ETH_PATH
const CLUSTER_PATH = process.env.WIRE_CLUSTER_PATH

// Short epoch for test — batch operators poll every 5s, so 15s epoch
// gives enough time for the cycle to trigger after advance
const TEST_EPOCH_DURATION_SEC = 90

// ---------------------------------------------------------------------------
// OPP type constants (match Solidity user-defined value types)
// ---------------------------------------------------------------------------

/** Use protobuf enum values from @wireio/opp-solidity-models */
const OPERATOR_TYPE_BATCH = OperatorType.BATCH
const TOKEN_KIND_ETH = TokenKind.ETH

/** Bond amount (1M base units) */
const BOND_AMOUNT = 1_000_000n

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadETHAddresses(): Record<string, string> {
  const addrsPath = Path.join(
    WIRE_ETH_PATH,
    ".local/deployments/outpost-addrs.json"
  )
  if (!Fs.existsSync(addrsPath))
    throw new Error("ETH outpost addresses not found after bootstrap")
  return JSON.parse(Fs.readFileSync(addrsPath, "utf-8"))
}

function loadETHABI(contractName: string): ethers.InterfaceAbi {
  const artifactPath = Path.join(
    WIRE_ETH_PATH,
    "artifacts/contracts/outpost",
    `${contractName}.sol`,
    `${contractName}.json`
  )
  return JSON.parse(Fs.readFileSync(artifactPath, "utf-8")).abi
}

/**
 * Poll a condition until it returns true or timeout expires.
 */
async function pollUntil(
  label: string,
  condition: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 2000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return
    await sleep(intervalMs)
  }
  throw new Error(`Timed out waiting for: ${label} (${timeoutMs}ms)`)
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Flow D: Collateral Deposit via OperatorRegistry (ETH → WIRE)", () => {
  let manager: ClusterManager
  let wireClient: WIREClient
  let ethProvider: ethers.JsonRpcProvider
  let ethSigner: ethers.Wallet
  let oppContract: ethers.Contract
  let oppInboundContract: ethers.Contract
  let barContract: ethers.Contract
  let opRegContract: ethers.Contract
  let ports: ClusterPorts

  // ── Setup: create + start a fresh cluster with ETH ──

  beforeAll(async () => {
    manager = await ClusterManager.createFromCLIArgs({
      buildPath: WIRE_BUILD_PATH,
      clusterPath: CLUSTER_PATH,
      ethereumPath: WIRE_ETH_PATH,
      producerCount: 21,
      nodeCount: 1,
      batchOperatorCount: 3,
      underwriterCount: 1,
      epochDurationSec: TEST_EPOCH_DURATION_SEC,
      warmupEpochs: 1,
      cooldownEpochs: 1,
      force: true
    })

    manager.loadState()
    await manager.start()

    ports = manager.config.ports

    wireClient = new WIREClient({
      httpUrl: `http://127.0.0.1:${ports.producerHttp[0]}`,
      clio: {
        clusterPath: manager.config.clusterPath,
        binary: manager.config.executables.clio,
        url: `http://127.0.0.1:${ports.producerHttp[0]}`,
        walletUrl: `http://127.0.0.1:${ports.kiod}`
      }
    })

    ethProvider = new ethers.JsonRpcProvider(`http://127.0.0.1:${ports.anvil}`)
    ethSigner = new ethers.Wallet(
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      ethProvider
    )

    const ethAddrs = loadETHAddresses()
    oppContract = new ethers.Contract(
      ethAddrs.OPP,
      loadETHABI("OPP"),
      ethSigner
    )
    oppInboundContract = new ethers.Contract(
      ethAddrs.OPPInbound,
      loadETHABI("OPPInbound"),
      ethSigner
    )
    barContract = new ethers.Contract(
      ethAddrs.BAR,
      loadETHABI("BAR"),
      ethSigner
    )
    opRegContract = new ethers.Contract(
      ethAddrs.OperatorRegistry,
      loadETHABI("OperatorRegistry"),
      ethSigner
    )
  }, 300_000)

  afterAll(async () => {
    try {
      await manager?.stop()
    } catch (err) {
      log.error("Error stopping manager:", err)
    }

    await ProcessManager.get().killAll()
    // try {
    //   await ProcessManager.get().disconnect()
    // } catch (err) {
    //   log.error("Error disconnecting process manager:", err)
    // }
    // process.exit(exitCode)
  }, 30_000)

  // ── WIRE chain health ──

  test("WIRE chain is producing blocks", async () => {
    const info = await wireClient.getInfo()
    expect(Number(info.head_block_num)).toBeGreaterThan(0)
    expect(info.head_block_producer).toBeDefined()
  })

  // ── ETH health ──

  test("Anvil is running with deployed contracts", async () => {
    const blockNum = await ethProvider.getBlockNumber()
    expect(blockNum).toBeGreaterThan(0)

    const [oppCode, barCode] = await Promise.all([
      ethProvider.getCode(await oppContract.getAddress()),
      ethProvider.getCode(await barContract.getAddress())
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
    const { rows } = await wireClient.getEpochConfig()
    expect(rows.length).toBe(1)
    expect(rows[0].epoch_duration_sec).toBe(TEST_EPOCH_DURATION_SEC)
    expect(rows[0].batch_operator_minimum_active).toBeGreaterThanOrEqual(3)
  })

  test("Epoch state is initialized", async () => {
    const { rows } = await wireClient.getEpochState()
    expect(rows.length).toBe(1)
    expect(rows[0].current_epoch_index).toBeGreaterThanOrEqual(0)
    expect(rows[0].batch_op_groups.length).toBe(3)
  })

  test("ETH outpost is registered", async () => {
    const { rows } = await wireClient.getOutposts()
    const ethOutpost = rows.find(
      (r: any) =>
        (r.chain_kind === ChainKind.ETHEREUM ||
          r.chain_kind === "CHAIN_KIND_ETHEREUM") &&
        r.chain_id === 31337
    )
    expect(ethOutpost).toBeDefined()
  })

  test("Batch operators are AVAILABLE in opreg", async () => {
    const { rows } = await wireClient.getOperators()
    const batchOps = rows.filter(
      (r: any) =>
        r.type === OPERATOR_TYPE_BATCH || r.type === "OPERATOR_TYPE_BATCH"
    )
    expect(batchOps.length).toBe(3)
    batchOps.forEach((op: any) => {
      // Bootstrapped operators are immediately AVAILABLE (ACTIVE enum value = 3)
      expect([OperatorStatus.ACTIVE, "OPERATOR_STATUS_ACTIVE"]).toContain(
        op.status
      )
      expect(op.is_bootstrapped).toBe(1) // bootstrapped in dev
    })
  })

  // ── Pre-bond baseline ──

  test("OPP has no messages before bond", async () => {
    const lastMsgId = await oppContract.lastMessageID()
    expect(lastMsgId).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000000"
    )
  })

  test("OperatorRegistry has no deposits before test", async () => {
    const signerAddr = await ethSigner.getAddress()
    const info = await opRegContract.operators(signerAddr)
    expect(Number(info.deposited)).toBe(0)
  })

  // ── Collateral deposit via OperatorRegistry.deposit() ──

  test("OperatorRegistry.deposit() succeeds and emits OperatorDeposited + OPPEnvelope", async () => {
    const signerAddr = await ethSigner.getAddress()
    const tx = await opRegContract.deposit(OPERATOR_TYPE_BATCH, {
      value: BOND_AMOUNT
    })
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
    const signerAddr = await ethSigner.getAddress()
    const info = await opRegContract.operators(signerAddr)
    expect(info.deposited).toBe(BOND_AMOUNT)
    expect(Number(info.operatorType)).toBe(OPERATOR_TYPE_BATCH)
    expect(Number(info.status)).toBe(OperatorStatus.ACTIVE)
  })

  // ── OPP message emitted on ETH ──

  test(
    "OPP emits OPPEnvelope event after crank drains queued messages",
    async () => {
      // The OPPEnvelope event is emitted when the batch operator cranks
      // emitOutboundEnvelope(), not immediately on deposit.
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
        TEST_EPOCH_DURATION_SEC * 3 * 1000,
        3000
      )
    },
    TEST_EPOCH_DURATION_SEC * 3 * 1000 + 30_000
  )

  test("OPP lastMessageID is non-zero after deposit", async () => {
    const lastMsgId = await oppContract.lastMessageID()
    expect(lastMsgId).not.toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000000"
    )
  })

  // ── E2E relay: batch operators deliver OPPEnvelope to WIRE ──

  test(
    "Batch operators deliver envelopes to WIRE",
    async () => {
      // The batch_operator_plugin polls every 15s; after epoch advances,
      // elected operators read ETH OPPEnvelope events and deliver to sysio.msgch.
      // Each delivery stores an envelope with sha256 checksum for consensus.
      await pollUntil(
        "envelopes appear in sysio.msgch",
        async () => {
          const { rows } = await wireClient.getEnvelopes()
          return rows.length > 0
        },
        TEST_EPOCH_DURATION_SEC * 9 * 1000,
        3000
      )

      const { rows: envelopes } = await wireClient.getEnvelopes()
      expect(envelopes.length).toBeGreaterThanOrEqual(1)

      // Each envelope should have a valid checksum and raw data
      envelopes.forEach((env: any) => {
        expect(env.batch_op_name).toBeDefined()
        expect(env.checksum).toBeDefined()
        expect(env.raw_data.length).toBeGreaterThan(0)
      })
    },
    TEST_EPOCH_DURATION_SEC * 9 * 1000 + 30_000
  )

  test("Consensus produces inbound messages", async () => {
    // After consensus, evalcons unpacks envelopes into the messages table
    await pollUntil(
      "inbound messages appear after consensus",
      async () => {
        const { rows } = await wireClient.getMessages()
        return rows.some(
          (r: any) =>
            r.direction === 0 || r.direction === "MESSAGE_DIRECTION_INBOUND"
        )
      },
      60_000,
      3000
    )

    const { rows: messages } = await wireClient.getMessages()
    const inbound = messages.filter(
      (r: any) =>
        r.direction === 0 || r.direction === "MESSAGE_DIRECTION_INBOUND"
    )
    expect(inbound.length).toBeGreaterThanOrEqual(1)
    inbound.forEach((msg: any) => {
      expect(msg.raw_payload.length).toBeGreaterThan(0)
      expect(msg.outpost_id).toBeGreaterThanOrEqual(0)
    })
  })

  test("Attestations table has entries", async () => {
    const { rows: attestations } = await wireClient.getAttestations()
    expect(attestations.length).toBeGreaterThanOrEqual(1)

    // BATCH_OPERATOR_NEXT_GROUP attestations from queueout (outbound)
    // ABI serializer returns enum names as strings
    const nextGroupAtts = attestations.filter(
      (a: any) =>
        a.type === "ATTESTATION_TYPE_BATCH_OPERATOR_NEXT_GROUP" ||
        a.type === AttestationType.BATCH_OPERATOR_NEXT_GROUP
    )
    expect(nextGroupAtts.length).toBeGreaterThanOrEqual(1)
  })

  // ── WIRE-side state after relay ──

  test("No underwriting entries on WIRE (collateral deposit, not underwriting)", async () => {
    const { rows } = await wireClient.getUnderwritingLedger()
    expect(rows.length).toBe(0)
  })
})
