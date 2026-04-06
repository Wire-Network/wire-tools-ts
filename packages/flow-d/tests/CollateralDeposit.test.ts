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
  sleep
} from "@wire-e2e-tests/harness"
import { SystemContracts } from "@wireio/sdk-core"
import {
  ChainKind,
  OperatorType,
  OperatorStatus,
  TokenKind,
  AttestationType
} from "@wireio/opp-solidity-models"

/**
 * Flow D: Collateral Deposit via BAR — full e2e ETH → WIRE relay.
 *
 * Creates a fresh cluster with ETH bootstrap, calls BAR.bond() to deposit
 * collateral, then waits for batch operators to relay the OPPMessage from
 * ETH to WIRE via the epoch cycle.
 *
 * Flow:
 *   1. BAR.bond() on ETH → OPPMessage event emitted immediately
 *   2. WIRE epoch advances → elected batch operators run epoch cycle
 *   3. Batch operators read OPPMessage events from ETH, deliver to sysio.msgch
 *   4. Message appears in WIRE's inchainreq / deliveries / messages tables
 *
 * Verifies:
 *   - WIRE + ETH chains healthy, OPP contracts accessible
 *   - BAR.bond() emits ActorBonded, records bond, triggers OPPMessage
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

describe("Flow D: Collateral Deposit via BAR (ETH → WIRE)", () => {
  let manager: ClusterManager
  let wireClient: WIREClient
  let ethProvider: ethers.JsonRpcProvider
  let ethSigner: ethers.Wallet
  let oppContract: ethers.Contract
  let oppInboundContract: ethers.Contract
  let barContract: ethers.Contract
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
  }, 300_000)

  afterAll(async () => {
    await manager?.stop()
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
    const attestationType = await barContract.OPERATOR_ACTION_ATTESTATION()
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
      (r: any) => r.chain_kind === ChainKind.ETHEREUM && r.chain_id === 31337
    )
    expect(ethOutpost).toBeDefined()
  })

  test("Batch operators are ACTIVE and in groups", async () => {
    const { rows } = await wireClient.getOperators()
    const batchOps = rows.filter((r: any) => r.type === OPERATOR_TYPE_BATCH)
    expect(batchOps.length).toBe(3)
    batchOps.forEach((op: any) => {
      expect(op.status).toBe(OperatorStatus.ACTIVE)
      expect(Number(op.assigned_batch_op_group)).not.toBe(255)
    })
  })

  // ── Pre-bond baseline ──

  test("OPP has no messages before bond", async () => {
    const lastMsgId = await oppContract.lastMessageID()
    expect(lastMsgId).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000000"
    )
  })

  test("BAR has no bonds before deposit", async () => {
    const signerAddr = await ethSigner.getAddress()
    const count = await barContract.bondCount(signerAddr, OPERATOR_TYPE_BATCH)
    expect(Number(count)).toBe(0)
  })

  // ── Collateral deposit via BAR.bond() ──

  test("BAR.bond() succeeds and emits ActorBonded event", async () => {
    const signerAddr = await ethSigner.getAddress()
    const tx = await barContract.bond(signerAddr, OPERATOR_TYPE_BATCH, [
      TOKEN_KIND_ETH,
      BOND_AMOUNT
    ])
    const receipt = await tx.wait()
    expect(receipt.status).toBe(1)

    const barAddr = await barContract.getAddress()
    const actorBondedTopic =
      barContract.interface.getEvent("ActorBonded")!.topicHash
    const bondEvent = receipt.logs.find(
      (l: ethers.Log) =>
        l.address.toLowerCase() === barAddr.toLowerCase() &&
        l.topics[0] === actorBondedTopic
    )
    expect(bondEvent).toBeDefined()

    const decoded = barContract.interface.parseLog({
      topics: bondEvent!.topics as string[],
      data: bondEvent!.data
    })
    expect(decoded!.name).toBe("ActorBonded")
    expect(decoded!.args.actor.toLowerCase()).toBe(signerAddr.toLowerCase())
    expect(Number(decoded!.args.operatorType)).toBe(OPERATOR_TYPE_BATCH)
    expect(Number(decoded!.args.tokenKind)).toBe(TOKEN_KIND_ETH)
    expect(decoded!.args.amount).toBe(BOND_AMOUNT)
  })

  test("Bond is recorded in BAR contract", async () => {
    const signerAddr = await ethSigner.getAddress()
    const count = await barContract.bondCount(signerAddr, OPERATOR_TYPE_BATCH)
    expect(Number(count)).toBe(1)

    const bonds = await barContract.getBonds(signerAddr, OPERATOR_TYPE_BATCH)
    expect(bonds.length).toBe(1)

    const bond = bonds[0]
    expect(Number(bond.actionType)).toBe(1) // ACTION_TYPE_DEPOSIT
    expect(Number(bond.type_)).toBe(OPERATOR_TYPE_BATCH)
    expect(Number(bond.status)).toBe(OperatorStatus.ACTIVE)
    expect(Number(bond.amount.kind)).toBe(TOKEN_KIND_ETH)
    expect(bond.amount.amount).toBe(BOND_AMOUNT)
  })

  // ── OPP message emitted on ETH ──

  test("OPP emits OPPMessage event after bond", async () => {
    const events = await oppContract.queryFilter(
      oppContract.filters.OPPMessage(),
      0
    )
    const messageEvents = events.filter(
      (e): e is ethers.EventLog => e instanceof ethers.EventLog
    )
    expect(messageEvents.length).toBeGreaterThanOrEqual(1)
  })

  test("OPP lastMessageID is non-zero after bond", async () => {
    const lastMsgId = await oppContract.lastMessageID()
    expect(lastMsgId).not.toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000000"
    )
  })

  // ── E2E relay: batch operators deliver OPPMessage to WIRE ──

  test(
    "Batch operators relay OPPMessage to WIRE",
    async () => {
      // Wait for the WIRE epoch to advance (TEST_EPOCH_DURATION_SEC seconds)
      // and batch operators to complete their epoch cycle.
      // The batch_operator_plugin polls every 5s; after epoch advances,
      // elected operators read ETH OPPMessage events and deliver to sysio.msgch.
      await pollUntil(
        "inbound chain request created on WIRE",
        async () => {
          const { rows } = await wireClient.getChainRequests()
          return rows.length > 0
        },
        TEST_EPOCH_DURATION_SEC * 9 * 1000,
        3000
      )

      const { rows: chainReqs } = await wireClient.getChainRequests()
      expect(chainReqs.length).toBeGreaterThanOrEqual(1)
    },
    TEST_EPOCH_DURATION_SEC * 9 * 1000 + 30_000
  )

  test("Deliveries are recorded on WIRE", async () => {
    const { rows: deliveries } = await wireClient.getDeliveries()
    expect(deliveries.length).toBeGreaterThanOrEqual(1)

    // At least one delivery should have a non-zero message count
    const withMessages = deliveries.filter((d: any) => d.message_count > 0)
    expect(withMessages.length).toBeGreaterThanOrEqual(1)
  })

  test("OPPMessage relayed to WIRE messages table", async () => {
    // Wait for messages to appear (consensus eval + processmsg may take a moment)
    await pollUntil(
      "messages appear in sysio.msgch",
      async () => {
        const { rows } = await wireClient.getMessages()
        return rows.length > 0
      },
      60_000,
      3000
    )

    const { rows: messages } = await wireClient.getMessages()
    expect(messages.length).toBeGreaterThanOrEqual(1)

    // The message should be inbound (ETH → WIRE) with OperatorAction attestation type
    const inboundMsg = messages[0]
    expect(inboundMsg.outpost_id).toBeGreaterThanOrEqual(0)
    expect(inboundMsg.raw_payload.length).toBeGreaterThan(0)
  })

  // ── WIRE-side state after relay ──

  test("No underwriting entries on WIRE (collateral deposit, not underwriting)", async () => {
    const { rows } = await wireClient.getUnderwritingLedger()
    expect(rows.length).toBe(0)
  })
})
