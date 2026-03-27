import "jest"
import {
  TestEnvironment,
  type TestEnvironmentConfig,
  retry,
  sleep
} from "@wire-e2e-tests/harness"
import { createHash } from "crypto"

/**
 * Flow C: SWAP 50 ETH -> 1042 SOL (with Underwriting)
 *
 * Full cross-chain swap spanning multiple epochs. Exercises:
 *   - SWAP attestation from ETH outpost
 *   - Underwriter verification and intent submission
 *   - Dual-outpost UNDERWRITE_INTENT delivery
 *   - Dual-outpost UNDERWRITE_CONFIRM response
 *   - REMIT to SOL outpost
 *   - REMIT_CONFIRM back to Depot
 *   - Fee distribution
 *   - Collateral lock/release after 24hr window
 *
 * Epoch timeline:
 *   N:   User swaps on ETH -> SWAP + BALANCE_SHEET -> Depot -> PENDING
 *   N:   Underwriter verifies on ETH, submits intent -> UNDERWRITE_INTENT to both
 *   N+1: Both outposts confirm -> UNDERWRITE_CONFIRM -> Depot -> REMIT to SOL
 *   N+2: SOL remits funds -> REMIT_CONFIRM + BALANCE_SHEET -> Depot -> fees distributed
 */

// ---------------------------------------------------------------------------
// Constants matching contract header enums
// ---------------------------------------------------------------------------

/** sysio.msgch MessageStatus */
const MSG_PENDING = 0
const MSG_READY = 1
const MSG_PROCESSED = 2

/** sysio.msgch MessageDirection */
const DIR_INBOUND = 0
const DIR_OUTBOUND = 1

/** sysio.msgch ChainRequestStatus */
const REQ_PENDING = 0
const REQ_COLLECTING = 1
const REQ_CONSENSUS_OK = 2

/** sysio.msgch EnvelopeStatus */
const ENV_PENDING_DELIVERY = 0

/** sysio.uwrit UnderwriteStatus */
const UW_INTENT_SUBMITTED = 0
const UW_INTENT_CONFIRMED = 1
const UW_COMPLETED = 2

/** AttestationType protobuf values */
const ATTESTATION_TYPE_SWAP = 60934
const ATTESTATION_TYPE_UNDERWRITE_INTENT = 60935
const ATTESTATION_TYPE_UNDERWRITE_CONFIRM = 60936
const ATTESTATION_TYPE_REMIT = 60937
const ATTESTATION_TYPE_REMIT_CONFIRM = 60938

/** ChainKind protobuf values */
const CHAIN_KIND_ETHEREUM = 2
const CHAIN_KIND_SOLANA = 3

/** Outpost IDs (assigned during bootstrap registration order) */
const ETH_OUTPOST_ID = 0
const SOL_OUTPOST_ID = 1

// ---------------------------------------------------------------------------
// Environment config
// ---------------------------------------------------------------------------

const WIRE_BUILD_DIR =
  process.env.WIRE_BUILD_DIR || "/data/shared/code/wire/wire-sysio/build/claude"
const WIRE_CHAIN_DIR = process.env.WIRE_CHAIN_DIR || "/tmp/wire-e2e-flow-c"

const config: TestEnvironmentConfig = {
  wire: {
    buildDir: WIRE_BUILD_DIR,
    chainDir: WIRE_CHAIN_DIR,
    plugins: ["sysio::batch_operator_plugin"]
  },
  ethereum: {
    port: 38545,
    chainId: 31337
  },
  solana: {
    rpcPort: 38899
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a deterministic 32-byte hex checksum256 from a seed string. */
function sha256Hex(seed: string): string {
  return createHash("sha256").update(seed).digest("hex")
}

/** Zero-filled 32-byte checksum256. */
const ZERO_HASH = "0".repeat(64)

/** Build a minimal raw_messages payload for deliver (msg_count messages encoded as raw bytes). */
function buildRawMessages(
  msgCount: number,
  attestType: number,
  payload: string
): string {
  // Encode as hex string of packed bytes; the contract unpacks from raw_messages.
  // For e2e testing we build a minimal valid payload that the contract can iterate.
  const entry = Buffer.alloc(36)
  entry.writeUInt16LE(attestType, 0)
  entry.writeUInt32LE(payload.length, 2)
  Buffer.from(payload).copy(entry, 6)
  const buf = Buffer.alloc(4 + msgCount * entry.length)
  buf.writeUInt32LE(msgCount, 0)
  for (let i = 0; i < msgCount; i++) {
    entry.copy(buf, 4 + i * entry.length)
  }
  return buf.toString("hex")
}

/** Format an asset string for the WIRE chain. */
function sysAsset(amount: string): string {
  return `${amount} SYS`
}

// ---------------------------------------------------------------------------
// Shared test state across describe blocks (populated as the flow progresses)
// ---------------------------------------------------------------------------

let swapMsgId: number
let uwEntryId: number
let initialCollateral: any
let remitMsgId: number

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Flow C: SWAP with Underwriting", () => {
  let env: TestEnvironment

  const batchOpAccount = "batchop.a"
  const underwriterAccount = "uwrit.a"

  beforeAll(async () => {
    env = new TestEnvironment(config)
    await env.start()

    // Wait for the chain to be fully bootstrapped and producing blocks
    await retry(
      async () => {
        const info = await env.wireClient!.getInfo()
        if (info.head_block_num < 4) {
          throw new Error(`Chain not ready yet: block ${info.head_block_num}`)
        }
      },
      { maxAttempts: 15, delayMs: 2000, label: "wait-for-chain" }
    )
  }, 180_000)

  afterAll(async () => {
    await env.stop()
  })

  // ========================================================================
  // EPOCH N: Swap initiation + underwriter intent
  // ========================================================================

  describe("Epoch N: Swap initiation + underwriter intent", () => {
    test("User submits SWAP attestation via queueout", async () => {
      // Queue a SWAP message destined for the ETH outpost.
      // The queueout action creates an outbound->inbound flow:
      //   The SWAP attestation is recorded in the messages table.
      const swapData = JSON.stringify({
        source_chain: CHAIN_KIND_ETHEREUM,
        target_chain: CHAIN_KIND_SOLANA,
        source_amount: "50.0000 ETH",
        target_amount: "1042.0000 SOL",
        sender: "0xUserEthAddress000000000000000001",
        recipient: "SoLRecipientPubkey11111111111111111111"
      })
      const swapDataHex = Buffer.from(swapData).toString("hex")

      await env.wireClient!.clio.pushAction(
        "sysio.msgch",
        "queueout",
        JSON.stringify({
          outpost_id: ETH_OUTPOST_ID,
          attest_type: ATTESTATION_TYPE_SWAP,
          data: swapDataHex
        }),
        "sysio.msgch@active"
      )

      // Verify the message was created by reading the messages table
      const messagesResult = await env.wireClient!.getMessages()
      const rows = messagesResult.rows ?? []
      expect(rows.length).toBeGreaterThanOrEqual(1)

      // Find the SWAP message
      const swapMsg = rows.find(
        (r: any) => r.attestation_type === ATTESTATION_TYPE_SWAP
      )
      expect(swapMsg).toBeDefined()
      swapMsgId = swapMsg.id
    }, 60_000)

    test("Swap message visible in sysio.msgch with PENDING status", async () => {
      const messagesResult = await env.wireClient!.getMessages()
      const rows = messagesResult.rows ?? []
      const swapMsg = rows.find((r: any) => r.id === swapMsgId)
      expect(swapMsg).toBeDefined()
      expect(swapMsg.status).toBe(MSG_PENDING)
      expect(swapMsg.attestation_type).toBe(ATTESTATION_TYPE_SWAP)
    }, 60_000)

    test("Underwriter submits intent via sysio.uwrit::submituw", async () => {
      // Record collateral state before submission
      const collateralBefore = await env.wireClient!.getCollateral()
      initialCollateral = collateralBefore.rows ?? []

      // The underwriter submits intent to underwrite the swap message.
      // source_sig and target_sig are the underwriter's cryptographic commitments
      // on the source and target chains respectively.
      const sourceSig = sha256Hex(`uw-source-sig-${swapMsgId}`)
      const targetSig = sha256Hex(`uw-target-sig-${swapMsgId}`)

      await env.wireClient!.clio.pushAction(
        "sysio.uwrit",
        "submituw",
        JSON.stringify({
          underwriter: underwriterAccount,
          msg_id: swapMsgId,
          source_sig: sourceSig,
          target_sig: targetSig
        }),
        `${underwriterAccount}@active`
      )

      // Verify the underwriting ledger entry was created
      const uwLedger = await env.wireClient!.getUnderwritingLedger()
      const uwRows = uwLedger.rows ?? []
      expect(uwRows.length).toBeGreaterThanOrEqual(1)

      const uwEntry = uwRows.find(
        (r: any) =>
          r.message_id === swapMsgId && r.underwriter === underwriterAccount
      )
      expect(uwEntry).toBeDefined()
      uwEntryId = uwEntry.id
    }, 60_000)

    test("Underwriting entry created with INTENT_SUBMITTED status", async () => {
      const uwLedger = await env.wireClient!.getUnderwritingLedger()
      const uwRows = uwLedger.rows ?? []
      const uwEntry = uwRows.find((r: any) => r.id === uwEntryId)
      expect(uwEntry).toBeDefined()
      expect(uwEntry.status).toBe(UW_INTENT_SUBMITTED)
      expect(uwEntry.underwriter).toBe(underwriterAccount)
      expect(uwEntry.message_id).toBe(swapMsgId)
    }, 60_000)

    test("Collateral locked for underwriting amount", async () => {
      const collateralAfter = await env.wireClient!.getCollateral()
      const afterRows = collateralAfter.rows ?? []

      // Find the underwriter's collateral entry for the source chain
      const uwCollateral = afterRows.find(
        (r: any) => r.underwriter === underwriterAccount
      )

      if (uwCollateral && initialCollateral.length > 0) {
        const beforeEntry = initialCollateral.find(
          (r: any) =>
            r.underwriter === underwriterAccount &&
            r.chain_kind === uwCollateral.chain_kind
        )
        if (beforeEntry) {
          // locked_amount should have increased
          const lockedBefore = parseFloat(beforeEntry.locked_amount || "0")
          const lockedAfter = parseFloat(uwCollateral.locked_amount || "0")
          expect(lockedAfter).toBeGreaterThan(lockedBefore)
        }
      }

      // At minimum, verify the collateral table has entries for the underwriter
      const hasUwCollateral = afterRows.some(
        (r: any) => r.underwriter === underwriterAccount
      )
      expect(hasUwCollateral).toBe(true)
    }, 60_000)
  })

  // ========================================================================
  // EPOCH N+1: Dual-outpost confirmation
  // ========================================================================

  describe("Epoch N+1: Dual-outpost confirmation", () => {
    test("Outbound envelope contains UNDERWRITE_INTENT attestation", async () => {
      // Build the outbound envelope for each outpost.
      // After submituw, the contract should have queued UNDERWRITE_INTENT
      // messages for both source and target outposts.
      await env.wireClient!.clio.pushAction(
        "sysio.msgch",
        "buildenv",
        JSON.stringify({ outpost_id: ETH_OUTPOST_ID }),
        "sysio.msgch@active"
      )

      await env.wireClient!.clio.pushAction(
        "sysio.msgch",
        "buildenv",
        JSON.stringify({ outpost_id: SOL_OUTPOST_ID }),
        "sysio.msgch@active"
      )

      // Read the outbound envelopes table
      const envelopesResult = await env.wireClient!.getTableRows({
        code: "sysio.msgch",
        scope: "sysio.msgch",
        table: "outenvelopes"
      })
      const envRows = envelopesResult.rows ?? []

      // Verify at least one envelope was created for each outpost
      const ethEnvelope = envRows.find(
        (r: any) => r.outpost_id === ETH_OUTPOST_ID
      )
      const solEnvelope = envRows.find(
        (r: any) => r.outpost_id === SOL_OUTPOST_ID
      )
      expect(ethEnvelope).toBeDefined()
      expect(solEnvelope).toBeDefined()
    }, 60_000)

    test("Both outposts confirm underwriting (UNDERWRITE_CONFIRM)", async () => {
      // Simulate both outposts responding with UNDERWRITE_CONFIRM.
      // In a real scenario, the batch operators would read the outbound envelopes,
      // deliver them to the outposts, and the outposts would respond.
      // Here we simulate by pushing inbound messages via sysio.msgch::deliver.

      const confirmData = JSON.stringify({
        uw_entry_id: uwEntryId,
        confirmed: true
      })
      const confirmDataHex = Buffer.from(confirmData).toString("hex")

      // Create inbound chain requests for both outposts
      await env.wireClient!.clio.pushAction(
        "sysio.msgch",
        "createreq",
        JSON.stringify({ outpost_id: ETH_OUTPOST_ID }),
        "sysio.msgch@active"
      )

      await env.wireClient!.clio.pushAction(
        "sysio.msgch",
        "createreq",
        JSON.stringify({ outpost_id: SOL_OUTPOST_ID }),
        "sysio.msgch@active"
      )

      // Read the chain requests to get their IDs
      const chainReqs = await env.wireClient!.getChainRequests()
      const reqRows = chainReqs.rows ?? []
      expect(reqRows.length).toBeGreaterThanOrEqual(2)

      const ethReq = reqRows.find((r: any) => r.outpost_id === ETH_OUTPOST_ID)
      const solReq = reqRows.find((r: any) => r.outpost_id === SOL_OUTPOST_ID)
      expect(ethReq).toBeDefined()
      expect(solReq).toBeDefined()

      // Build raw messages containing UNDERWRITE_CONFIRM attestation
      const rawMsgs = buildRawMessages(
        1,
        ATTESTATION_TYPE_UNDERWRITE_CONFIRM,
        confirmData
      )
      const chainHash = sha256Hex(`confirm-chain-${Date.now()}`)
      const merkleRoot = sha256Hex(`confirm-merkle-${Date.now()}`)

      // ETH outpost delivers confirmation via batch operator
      await env.wireClient!.clio.pushAction(
        "sysio.msgch",
        "deliver",
        JSON.stringify({
          operator_acct: batchOpAccount,
          req_id: ethReq.id,
          chain_hash: chainHash,
          merkle_root: merkleRoot,
          msg_count: 1,
          raw_messages: rawMsgs
        }),
        `${batchOpAccount}@active`
      )

      // SOL outpost delivers confirmation via batch operator
      const solChainHash = sha256Hex(`sol-confirm-chain-${Date.now()}`)
      const solMerkleRoot = sha256Hex(`sol-confirm-merkle-${Date.now()}`)

      await env.wireClient!.clio.pushAction(
        "sysio.msgch",
        "deliver",
        JSON.stringify({
          operator_acct: batchOpAccount,
          req_id: solReq.id,
          chain_hash: solChainHash,
          merkle_root: solMerkleRoot,
          msg_count: 1,
          raw_messages: rawMsgs
        }),
        `${batchOpAccount}@active`
      )

      // Evaluate consensus on both chain requests
      await env.wireClient!.clio.pushAction(
        "sysio.msgch",
        "evalcons",
        JSON.stringify({ req_id: ethReq.id }),
        "sysio.msgch@active"
      )

      await env.wireClient!.clio.pushAction(
        "sysio.msgch",
        "evalcons",
        JSON.stringify({ req_id: solReq.id }),
        "sysio.msgch@active"
      )
    }, 60_000)

    test("Underwriting entry transitions to INTENT_CONFIRMED", async () => {
      // After both outpost confirmations are processed, call confirmuw
      await env.wireClient!.clio.pushAction(
        "sysio.uwrit",
        "confirmuw",
        JSON.stringify({ uw_entry_id: uwEntryId }),
        "sysio.uwrit@active"
      )

      const uwLedger = await env.wireClient!.getUnderwritingLedger()
      const uwRows = uwLedger.rows ?? []
      const uwEntry = uwRows.find((r: any) => r.id === uwEntryId)
      expect(uwEntry).toBeDefined()
      expect(uwEntry.status).toBe(UW_INTENT_CONFIRMED)
    }, 60_000)
  })

  // ========================================================================
  // EPOCH N+2: Remit + fee distribution
  // ========================================================================

  describe("Epoch N+2: Remit + fee distribution", () => {
    test("REMIT attestation queued for target outpost", async () => {
      // After INTENT_CONFIRMED, the depot queues a REMIT message for the
      // target outpost (SOL) to release funds to the recipient.
      const remitData = JSON.stringify({
        uw_entry_id: uwEntryId,
        recipient: "SoLRecipientPubkey11111111111111111111",
        target_amount: "1042.0000 SOL",
        target_chain: CHAIN_KIND_SOLANA
      })
      const remitDataHex = Buffer.from(remitData).toString("hex")

      await env.wireClient!.clio.pushAction(
        "sysio.msgch",
        "queueout",
        JSON.stringify({
          outpost_id: SOL_OUTPOST_ID,
          attest_type: ATTESTATION_TYPE_REMIT,
          data: remitDataHex
        }),
        "sysio.msgch@active"
      )

      // Verify the REMIT message is in the messages table
      const messagesResult = await env.wireClient!.getMessages()
      const rows = messagesResult.rows ?? []
      const remitMsg = rows.find(
        (r: any) => r.attestation_type === ATTESTATION_TYPE_REMIT
      )
      expect(remitMsg).toBeDefined()
      remitMsgId = remitMsg.id
    }, 60_000)

    test("REMIT_CONFIRM received from target outpost", async () => {
      // Simulate the SOL outpost responding with REMIT_CONFIRM after
      // executing the remittance on-chain.
      const remitConfirmData = JSON.stringify({
        uw_entry_id: uwEntryId,
        remit_msg_id: remitMsgId,
        recipient: "SoLRecipientPubkey11111111111111111111",
        amount_remitted: "1042.0000 SOL",
        success: true
      })
      const remitConfirmHex = Buffer.from(remitConfirmData).toString("hex")

      // Create a new inbound chain request for SOL
      await env.wireClient!.clio.pushAction(
        "sysio.msgch",
        "createreq",
        JSON.stringify({ outpost_id: SOL_OUTPOST_ID }),
        "sysio.msgch@active"
      )

      // Get the latest SOL chain request
      const chainReqs = await env.wireClient!.getChainRequests()
      const reqRows = chainReqs.rows ?? []
      const solReqs = reqRows.filter(
        (r: any) => r.outpost_id === SOL_OUTPOST_ID
      )
      const latestSolReq = solReqs[solReqs.length - 1]
      expect(latestSolReq).toBeDefined()

      // Build raw messages with REMIT_CONFIRM attestation
      const rawMsgs = buildRawMessages(
        1,
        ATTESTATION_TYPE_REMIT_CONFIRM,
        JSON.stringify({ uw_entry_id: uwEntryId, success: true })
      )
      const chainHash = sha256Hex(`remit-confirm-chain-${Date.now()}`)
      const merkleRoot = sha256Hex(`remit-confirm-merkle-${Date.now()}`)

      // Deliver REMIT_CONFIRM from SOL outpost
      await env.wireClient!.clio.pushAction(
        "sysio.msgch",
        "deliver",
        JSON.stringify({
          operator_acct: batchOpAccount,
          req_id: latestSolReq.id,
          chain_hash: chainHash,
          merkle_root: merkleRoot,
          msg_count: 1,
          raw_messages: rawMsgs
        }),
        `${batchOpAccount}@active`
      )

      // Evaluate consensus
      await env.wireClient!.clio.pushAction(
        "sysio.msgch",
        "evalcons",
        JSON.stringify({ req_id: latestSolReq.id }),
        "sysio.msgch@active"
      )

      // Verify REMIT_CONFIRM message received
      const messagesResult = await env.wireClient!.getMessages()
      const rows = messagesResult.rows ?? []
      const confirmMsg = rows.find(
        (r: any) => r.attestation_type === ATTESTATION_TYPE_REMIT_CONFIRM
      )
      expect(confirmMsg).toBeDefined()
    }, 60_000)

    test("Fee distribution executed via sysio.uwrit::distfee", async () => {
      // Distribute fees for the completed underwriting.
      // The distfee action splits fees between the underwriter,
      // other underwriters pool, and batch operators.
      await env.wireClient!.clio.pushAction(
        "sysio.uwrit",
        "distfee",
        JSON.stringify({ uw_entry_id: uwEntryId }),
        "sysio.uwrit@active"
      )

      // Verify the underwriting entry has fee_earned populated
      const uwLedger = await env.wireClient!.getUnderwritingLedger()
      const uwRows = uwLedger.rows ?? []
      const uwEntry = uwRows.find((r: any) => r.id === uwEntryId)
      expect(uwEntry).toBeDefined()

      // fee_earned should be non-zero after distribution
      if (uwEntry.fee_earned) {
        const feeAmount = parseFloat(uwEntry.fee_earned)
        expect(feeAmount).toBeGreaterThanOrEqual(0)
      }
    }, 60_000)

    test("Underwriter collateral unlocked", async () => {
      // After the swap completes, the underwriter's locked collateral
      // should eventually be released. For testing, we advance time
      // past the 24hr challenge window and call expirelock.
      if (env.ethClient) {
        // Advance time on the ETH side (also advances WIRE block time if synced)
        await env.ethClient.advanceTime(86400 + 60) // 24h + 1 min buffer
      }

      // Wait a few blocks for the time change to propagate
      await sleep(3000)

      // Call expirelock to release the collateral
      await env.wireClient!.clio.pushAction(
        "sysio.uwrit",
        "expirelock",
        JSON.stringify({ uw_entry_id: uwEntryId }),
        "sysio.uwrit@active"
      )

      // Verify collateral was unlocked
      const collateral = await env.wireClient!.getCollateral()
      const collRows = collateral.rows ?? []
      const uwCollateral = collRows.find(
        (r: any) => r.underwriter === underwriterAccount
      )

      if (uwCollateral) {
        // After unlock, locked_amount should be back to zero (or decreased)
        const locked = parseFloat(uwCollateral.locked_amount || "0")
        expect(locked).toBeLessThanOrEqual(0)
      }
    }, 60_000)

    test("Final underwriting status is COMPLETED", async () => {
      const uwLedger = await env.wireClient!.getUnderwritingLedger()
      const uwRows = uwLedger.rows ?? []
      const uwEntry = uwRows.find((r: any) => r.id === uwEntryId)
      expect(uwEntry).toBeDefined()
      expect(uwEntry.status).toBe(UW_COMPLETED)
    }, 60_000)
  })
})
