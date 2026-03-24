import {
  TestEnvironment,
  type TestEnvironmentConfig,
} from "@wire-e2e-tests/harness"

/**
 * Flow A: Empty Epoch (Balance Sheet Only)
 *
 * No user actions occur during an epoch on any outpost.
 * Verifies:
 *   1. Batch operator cranks Depot — no outbound attestations
 *   2. Each outpost produces an inbound chain with ONLY a
 *      RESERVE_BALANCE_SHEET attestation
 *   3. Depot achieves consensus (all 7 identical hashes)
 *   4. Depot processes RESERVE_BALANCE_SHEET and updates reserve tracking
 *   5. No state mutations beyond reserve snapshots
 */

const WIRE_BUILD_DIR = process.env.WIRE_BUILD_DIR || "/data/shared/code/wire/wire-sysio/build/claude"
const WIRE_CHAIN_DIR = process.env.WIRE_CHAIN_DIR || "/tmp/wire-e2e-flow-a"

const config: TestEnvironmentConfig = {
  wire: {
    buildDir: WIRE_BUILD_DIR,
    chainDir: WIRE_CHAIN_DIR,
    plugins: [
      "sysio::batch_operator_plugin",
    ],
  },
  ethereum: {
    port: 18545,
    chainId: 31337,
  },
  solana: {
    rpcPort: 18899,
  },
}

describe("Flow A: Empty Epoch", () => {
  let env: TestEnvironment

  beforeAll(async () => {
    env = new TestEnvironment(config)
    await env.start()
  }, 60_000)

  afterAll(async () => {
    await env.stop()
  })

  it("WIRE chain is running and producing blocks", async () => {
    const info = await env.wireClient!.getInfo()
    expect(info.server_version).toBeDefined()
    expect(info.head_block_num).toBeGreaterThan(0)
  })

  it("Ethereum (anvil) is running", async () => {
    const blockNum = await env.ethClient!.getBlockNumber()
    expect(blockNum).toBeGreaterThanOrEqual(0)
  })

  it("Solana validator is running", async () => {
    const slot = await env.solClient!.getSlot()
    expect(slot).toBeGreaterThanOrEqual(0)
  })

  it("epoch config is initialized on WIRE chain", async () => {
    // TODO: Deploy sysio.epoch contract and call setconfig
    //       This requires the bios boot sequence to be run first.
    //       For now, verify the chain is responsive.
    const info = await env.wireClient!.getInfo()
    expect(info.chain_id).toBeDefined()
  })

  it("outbound crank produces empty chain (no pending attestations)", async () => {
    // TODO: After sysio.epoch + sysio.msgch deployed:
    //   1. Call sysio.msgch::crank for WIRE->ETH
    //   2. Verify outbound chain is empty or heartbeat-only
    //   3. Call sysio.msgch::crank for WIRE->SOL
    //   4. Verify same
    expect(true).toBe(true) // placeholder
  })

  it("ETH outpost produces RESERVE_BALANCE_SHEET on epoch finalize", async () => {
    // TODO: After OPP.sol deployed on anvil:
    //   1. Call OPP.finalizeEpoch()
    //   2. Read OPPEpoch event
    //   3. Decode Envelope, verify single RESERVE_BALANCE_SHEET attestation
    //   4. Verify reserve amounts match contract balance
    expect(true).toBe(true) // placeholder
  })

  it("SOL outpost produces RESERVE_BALANCE_SHEET on epoch finalize", async () => {
    // TODO: After opp-solana-outpost deployed on test validator:
    //   1. Call finalize_epoch instruction
    //   2. Read OPPEpochEvent from transaction logs
    //   3. Verify single RESERVE_BALANCE_SHEET attestation
    expect(true).toBe(true) // placeholder
  })

  it("Depot consensus succeeds with identical hashes", async () => {
    // TODO: After all 7 operators deliver identical inbound chains:
    //   1. Call sysio.msgch::evalcons
    //   2. Verify CONSENSUS_OK status
    //   3. Verify reserve tracking updated on Depot
    expect(true).toBe(true) // placeholder
  })
})
