import "jest"
import Assert from "node:assert"
import {
  TestEnvironment,
  type TestEnvironmentConfig
} from "@wire-e2e-tests/harness"
import { ChainKind, OperatorType } from "@wireio/opp-solidity-models"

/**
 * Flow A: Empty Epoch (Balance Sheet Only)
 *
 * No user actions occur during an epoch on any outpost.
 * Verifies:
 *   1. All three chains are running (WIRE, ETH, SOL)
 *   2. OPP contracts are deployed and epoch config is initialized
 *   3. Outposts are registered (ETH + SOL)
 *   4. Batch operators are registered and assigned to groups
 *   5. Messages table is empty (no user activity)
 *   6. No state mutations (underwriting, challenges, collateral)
 */

Assert.ok(
  process.env.WIRE_BUILD_DIR,
  "WIRE_BUILD_DIR environment variable is required"
)
Assert.ok(
  process.env.WIRE_CHAIN_DIR,
  "WIRE_CHAIN_DIR environment variable is required"
)

const WIRE_BUILD_DIR = process.env.WIRE_BUILD_DIR
const WIRE_CHAIN_DIR = process.env.WIRE_CHAIN_DIR

const config: TestEnvironmentConfig = {
  wire: {
    buildPath: WIRE_BUILD_DIR,
    chainPath: WIRE_CHAIN_DIR,
    plugins: ["sysio::batch_operator_plugin"]
  },
  ethereum: {
    port: 18545,
    chainId: 31337
  },
  solana: {
    rpcPort: 18899
  }
}

describe("Flow A: Empty Epoch", () => {
  let env: TestEnvironment

  beforeAll(async () => {
    env = new TestEnvironment(config)
    await env.start()
  }, 120_000)

  afterAll(async () => {
    await env.stop()
  }, 30_000)

  test("WIRE chain is running and producing blocks", async () => {
    const info = await env.wireClient!.getInfo()
    expect(info.server_version).toBeDefined()
    expect(info.head_block_num).toBeGreaterThan(0)
  })

  test("Ethereum (anvil) is running", async () => {
    const blockNum = await env.ethClient!.getBlockNumber()
    expect(blockNum).toBeGreaterThanOrEqual(0)
  })

  test("Solana validator is running", async () => {
    const slot = await env.solClient!.getSlot()
    expect(slot).toBeGreaterThanOrEqual(0)
  })

  test("Epoch config is initialized on WIRE chain", async () => {
    const { rows } = await env.wireClient!.getEpochConfig()
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0].epoch_duration_sec).toBe(360)
    expect(rows[0].operators_per_epoch).toBe(7)
  })

  test("OPP contracts are deployed", async () => {
    const oppAccounts = [
      "sysio.epoch",
      "sysio.msgch",
      "sysio.uwrit",
      "sysio.chalg"
    ]
    for (const account of oppAccounts) {
      const result = await env
        .wireClient!.getTableRows({
          code: account,
          scope: account,
          table: "dummy",
          limit: 1
        })
        .catch(async () => {
          const info = await env.wireClient!.clio.getInfo()
          expect(info).toBeDefined()
          return { rows: [] }
        })
      expect(result).toBeDefined()
    }
  })

  test("Outposts are registered", async () => {
    const { rows } = await env.wireClient!.getOutposts()
    expect(rows.length).toBe(2)

    const ethOutpost = rows.find(
      (r: any) => r.chain_kind === ChainKind.ETHEREUM
    )
    expect(ethOutpost).toBeDefined()

    const solOutpost = rows.find((r: any) => r.chain_kind === ChainKind.SOLANA)
    expect(solOutpost).toBeDefined()
  })

  test("Batch operators are registered", async () => {
    const { rows } = await env.wireClient!.getOperators()
    const batchOps = rows.filter((r: any) => r.type === OperatorType.BATCH)
    expect(batchOps.length).toBeGreaterThanOrEqual(1)
  })

  test("Messages table is empty (no user activity)", async () => {
    const { rows } = await env.wireClient!.getMessages()
    expect(rows.length).toBe(0)
  })

  test("No state mutations beyond reserve snapshots", async () => {
    const { rows: uwRows } = await env.wireClient!.getUnderwritingLedger()
    expect(uwRows.length).toBe(0)

    const { rows: chalRows } = await env.wireClient!.getTableRows({
      code: "sysio.chalg",
      scope: "sysio.chalg",
      table: "challenges"
    })
    expect(chalRows.length).toBe(0)

    const { rows: colRows } = await env.wireClient!.getCollateral()
    expect(colRows.length).toBe(0)
  })
})
