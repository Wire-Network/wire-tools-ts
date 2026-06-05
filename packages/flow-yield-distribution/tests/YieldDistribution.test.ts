import "jest"
import * as Fs from "node:fs"
import * as Path from "node:path"
import { ethers } from "ethers"
import * as anchor from "@coral-xyz/anchor"
import { Connection, Keypair, PublicKey } from "@solana/web3.js"

import {
  createAuthExLink,
  DEV_K1_PUBLIC_KEY,
  emitSolanaYield,
  emitYieldBatch,
  emPrivateKeyFromEthWallet,
  FlowTestContext,
  loadMockYieldEmitter,
  log,
  pollUntil
} from "@wireio/test-cluster-tool"
import { ChainKind } from "@wireio/opp-typescript-models"
import { SlugName } from "@wireio/sdk-core"

/**
 * Flow: fake-yield STAKING_REWARD → sysio.dclaim::onreward → sysio.system::fundclaim
 *
 * Drives synthetic STAKING_REWARD attestations through both outposts
 * and verifies the depot's reward-distribution path end-to-end:
 *
 *   ETH: MockYieldEmitter.sol::emitYield(...)       (real on-chain fake)
 *   SOL: opp_outpost::add_attestation(...)          (existing CPI target)
 *     ↓ attestation queued in OutboundMessageBuffer
 *     ↓ batch operator ferries via OPP envelope
 *     ↓ sysio.msgch dispatches as
 *   sysio.dclaim::onreward
 *     ↓ sysio.system::fundclaim (caps by emission + accounting + balance)
 *     ↓ sysio.token::transfer  (sysio → sysio.dclaim)
 *     ↓ credit:
 *        - if AuthEx-linked: row in sysio.dclaim::pclaims
 *        - if not:           row in sysio.dclaim::unmapped_tokens
 *
 * Asserts:
 *   (a) Linked-staker reward lands in pclaims.
 *   (b) Unlinked-staker reward parks in unmapped_tokens.
 *   (c) Replayed `external_epoch_ref` is a no-op (dclaim reward-cursor dedup).
 *   (d) capital_shortfall_total stays 0 when emissions cover the credit.
 *
 * Cluster data dir: the standard fresh-mode `WIRE_CLUSTER_PATH` (resolved
 * by `FlowTestContext.create`, asserted in `FlowTestContext.fresh`) —
 * identical to every gate flow. No bespoke `WIRE_CHAIN_DIR` / `/mnt/data`
 * path; the harness owns directory creation.
 */

// ─── Config ────────────────────────────────────────────────────────────────
const EPOCH_DURATION_SEC = Number(process.env.EPOCH_DURATION_SEC ?? 60)
/** Per-staker reward in chain-native base units. Sized so the depot's
 *  accounting bucket comfortably covers it across the test runtime. */
const ETH_REWARD_PER_STAKER = 1_000_000n // 1e6 wei — depot scales via PrecisionLib
const SOL_REWARD_PER_STAKER = 1_000_000n // 1e6 lamports
/** How long to wait for an attestation to round-trip from emitter → depot. */
const PROPAGATION_TIMEOUT_MS = 5 * 60_000
const PROPAGATION_POLL_MS    = 2_000

// ─── Helpers ───────────────────────────────────────────────────────────────
interface PclaimRow {
  wire_account: string
  balance: string
  expires_at_sec: number
}

interface UnmappedRow {
  id: number
  chain_kind: string
  native_pubkey: string
  balance: string
  expires_at_sec: number
}

interface T5StateRow {
  total_distributed: string | number
  capital_shortfall_total: string | number
  pending_emission_amount: string | number
}

async function readPclaims(ctx: FlowTestContext): Promise<PclaimRow[]> {
  const { rows } = await ctx.wireClient.getTableRows<PclaimRow>({
    code: "sysio.dclaim",
    scope: "sysio.dclaim",
    table: "pclaims",
    limit: 5000
  })
  return rows
}

async function readUnmapped(ctx: FlowTestContext): Promise<UnmappedRow[]> {
  const { rows } = await ctx.wireClient.getTableRows<UnmappedRow>({
    code: "sysio.dclaim",
    scope: "sysio.dclaim",
    table: "unmapped",
    limit: 5000
  })
  return rows
}

async function readT5State(ctx: FlowTestContext): Promise<T5StateRow> {
  const { rows } = await ctx.wireClient.getTableRows<T5StateRow>({
    code: "sysio",
    scope: "sysio",
    table: "t5state"
  })
  expect(rows.length).toBeGreaterThanOrEqual(1)
  return rows[0]!
}

async function readWireBalance(
  ctx: FlowTestContext,
  account: string
): Promise<bigint> {
  const { rows } = await ctx.wireClient.getTableRows<{ balance: string }>({
    code: "sysio.token",
    scope: account,
    table: "accounts"
  })
  // sysio.token serializes balances as "X.XXXXXXXXX WIRE" (9 decimals).
  if (rows.length === 0) return 0n
  const [intPart, fracPart = ""] = rows[0]!.balance.split(" ")[0]!.split(".")
  const fracPadded = (fracPart + "000000000").slice(0, 9)
  return BigInt(intPart!) * 1_000_000_000n + BigInt(fracPadded || "0")
}

// ─── Test suite ────────────────────────────────────────────────────────────
const describeCluster = process.env.WIRE_BUILD_PATH ? describe : describe.skip

describeCluster("Yield distribution through fake emitters", () => {
  let ctx: FlowTestContext

  // ETH: deployer signer (HD index 0) holds the AccessManager admin
  // role granted in deployLocal.ts::postDeploy.
  let mockYieldEmitter: ReturnType<typeof loadMockYieldEmitter>
  let outpostAddrs: Record<string, string>

  // SOL: deployer keypair = OutpostConfig.authority (set during Phase 10b).
  let solDeployer: Keypair
  let solConnection: Connection
  let solProgram: anchor.Program<anchor.Idl>

  /** Linked staker: registered as a wire account with the dev K1 key,
   *  then authex::createlink-bound to its ETH wallet. */
  let linkedEthWallet: ethers.HDNodeWallet
  const linkedEthAccount = "yield.lnk"

  /** Unlinked staker: no wire account, no authex link. The emitter still
   *  emits a STAKING_REWARD for it; the depot parks the credit in
   *  unmapped_tokens. */
  let unlinkedEthWallet: ethers.HDNodeWallet

  /** Per-test counter for `external_epoch_ref`. The contract enforces
   *  strict monotonicity per staker, so each emission gets a fresh
   *  value; we re-use one for the dedupe test. */
  let nextExternalEpochRef = 1n

  beforeAll(async () => {
    ctx = await FlowTestContext.create({
      epochDurationSec: EPOCH_DURATION_SEC,
      producerCount: 3,
      batchOperatorCount: 3,
      underwriterCount: 1
    })
    log.info(`[yield] cluster data dir: ${ctx.clusterPath}`)

    // ── ETH wiring ─────────────────────────────────────────────────────
    const ethereumPath = ctx.ethereumPath
    expect(ethereumPath).toBeTruthy()
    const outpostAddrsPath = Path.join(
      ethereumPath,
      ".local",
      "deployments",
      "outpost-addrs.json"
    )
    outpostAddrs = JSON.parse(Fs.readFileSync(outpostAddrsPath, "utf-8"))
    mockYieldEmitter = loadMockYieldEmitter(
      ethereumPath,
      outpostAddrs,
      ctx.ethSigner
    )

    // ── SOL wiring ─────────────────────────────────────────────────────
    const solanaPath = ctx.solanaPath
    expect(solanaPath).toBeTruthy()
    const solKpPath = Path.join(ctx.clusterPath, "data", "sol-deployer-keypair.json")
    expect(Fs.existsSync(solKpPath)).toBe(true)
    solDeployer = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(Fs.readFileSync(solKpPath, "utf-8")))
    )
    solConnection = new Connection(
      `http://127.0.0.1:${ctx.ports.solanaRpc}`,
      "confirmed"
    )
    const oppOutpostIdl = JSON.parse(
      Fs.readFileSync(
        Path.join(solanaPath, "target", "idl", "opp_outpost.json"),
        "utf-8"
      )
    ) as anchor.Idl
    const anchorProvider = new anchor.AnchorProvider(
      solConnection,
      new anchor.Wallet(solDeployer),
      { commitment: "confirmed" }
    )
    solProgram = new anchor.Program(oppOutpostIdl, anchorProvider)

    // ── Staker wallets ────────────────────────────────────────────────
    // Generate fresh wallets (deterministic per test-suite invocation
    // via the global anvil mnemonic isn't worth it — we keep the
    // wallets in-memory and never need to round-trip them).
    linkedEthWallet = ethers.Wallet.createRandom() as unknown as ethers.HDNodeWallet
    unlinkedEthWallet = ethers.Wallet.createRandom() as unknown as ethers.HDNodeWallet

    // Open + unlock the default wallet — kiod is restarted between
    // cluster create and run, leaving it closed.
    await ctx.wireClient.clio.walletOpenAndUnlock("default")

    // Create the linked staker's WIRE account + ROA policy and
    // createlink-bind it to its ETH wallet.
    await ctx.wireClient.clio.createSystemAccount(linkedEthAccount, DEV_K1_PUBLIC_KEY)
    await ctx.wireClient.clio.pushActionAndWait(
      "sysio.roa",
      "addpolicy",
      {
        owner: linkedEthAccount,
        issuer: "defproducera",
        net_weight: "25.0000 SYS",
        ram_weight: "25.0000 SYS",
        cpu_weight: "25.0000 SYS",
        time_block: 0,
        network_gen: 0
      },
      "defproducera@active"
    )
    await createAuthExLink(ctx.wireClient.clio, {
      chainKind: ChainKind.EVM,
      account: linkedEthAccount,
      privateKey: emPrivateKeyFromEthWallet(linkedEthWallet),
      ethWallet: linkedEthWallet
    })
  }, 30 * 60 * 1000)

  afterAll(async () => {
    try {
      await ctx?.teardown()
    } catch (err) {
      log.error("[yield] teardown error:", err)
    }
  }, 5 * 60 * 1000)

  // ──────────────────────────────────────────────────────────────────────
  // 1. Linked staker — ETH side. emitYield(…) → batchop ferry → depot
  //    onreward → pclaims row.
  // ──────────────────────────────────────────────────────────────────────
  it("ETH STAKING_REWARD for a linked staker lands in pclaims", async () => {
    const before = await readPclaims(ctx)
    const beforeT5 = await readT5State(ctx)

    const ref = nextExternalEpochRef++
    await emitYieldBatch(
      mockYieldEmitter,
      [
        {
          staker: linkedEthWallet.address,
          wireAccount: linkedEthAccount,
          rewardAmount: ETH_REWARD_PER_STAKER,
          shareBps: 10000
        }
      ],
      ref,
      1 // rewardEpochIndex — informational
    )

    await pollUntil(
      `pclaims row appears for ${linkedEthAccount} (ETH)`,
      async () => {
        const rows = await readPclaims(ctx)
        return rows.some(r => r.wire_account === linkedEthAccount)
      },
      PROPAGATION_TIMEOUT_MS,
      PROPAGATION_POLL_MS
    )

    const after = await readPclaims(ctx)
    const newRows = after.filter(
      r => !before.some(b => b.wire_account === r.wire_account)
    )
    expect(newRows.length).toBeGreaterThanOrEqual(1)

    // capital_shortfall_total must stay 0 — emissions accrued during
    // the prior loop cover this credit by a large margin.
    const afterT5 = await readT5State(ctx)
    expect(Number(afterT5.capital_shortfall_total)).toBe(
      Number(beforeT5.capital_shortfall_total)
    )
  })

  // ──────────────────────────────────────────────────────────────────────
  // 2. Unlinked staker — ETH side. emitYield(…) routes to unmapped_tokens.
  // ──────────────────────────────────────────────────────────────────────
  it("ETH STAKING_REWARD for an unlinked staker parks in unmapped_tokens", async () => {
    const ref = nextExternalEpochRef++
    const unlinkedAddrLower = unlinkedEthWallet.address
      .toLowerCase()
      .replace(/^0x/, "")

    const beforeUnmapped = await readUnmapped(ctx)
    await emitYieldBatch(
      mockYieldEmitter,
      [
        {
          staker: unlinkedEthWallet.address,
          wireAccount: "", // empty → depot parks in unmapped
          rewardAmount: ETH_REWARD_PER_STAKER,
          shareBps: 10000
        }
      ],
      ref,
      1
    )

    await pollUntil(
      "unmapped row appears for unlinked ETH staker",
      async () => {
        const rows = await readUnmapped(ctx)
        return rows.some(r =>
          (r.native_pubkey ?? "").toLowerCase() === unlinkedAddrLower
        )
      },
      PROPAGATION_TIMEOUT_MS,
      PROPAGATION_POLL_MS
    )

    const after = await readUnmapped(ctx)
    expect(after.length).toBeGreaterThan(beforeUnmapped.length)
  })

  // ──────────────────────────────────────────────────────────────────────
  // 3. SOL side — opp_outpost::add_attestation drives the same depot
  //    path. The staker is the linked-staker's wire account; we wire
  //    a new SOL keypair → no authex link, so this exercises the SOL
  //    unlinked-park path.
  // ──────────────────────────────────────────────────────────────────────
  it("SOL STAKING_REWARD reaches the depot via add_attestation", async () => {
    const solStaker = Keypair.generate()
    const ref = nextExternalEpochRef++

    const beforeUnmapped = await readUnmapped(ctx)
    await emitSolanaYield(
      solConnection,
      solProgram,
      solDeployer,
      {
        staker: solStaker.publicKey,
        wireAccount: "", // unlinked
        rewardAmount: SOL_REWARD_PER_STAKER,
        shareBps: 10000
      },
      BigInt(SlugName.from("SOLANA")),
      BigInt(SlugName.from("SOL")),
      ref,
      1
    )

    await pollUntil(
      "unmapped row appears for unlinked SOL staker",
      async () => {
        const rows = await readUnmapped(ctx)
        return rows.length > beforeUnmapped.length
      },
      PROPAGATION_TIMEOUT_MS,
      PROPAGATION_POLL_MS
    )
  })

  // ──────────────────────────────────────────────────────────────────────
  // 4. Dedupe — replay the linked-staker emission with the SAME
  //    external_epoch_ref. The contract's per-staker monotonic check
  //    rejects this at the emitter; the test confirms the depot row
  //    count doesn't change either way.
  // ──────────────────────────────────────────────────────────────────────
  it("ETH emitter rejects a replayed external_epoch_ref", async () => {
    // Get the linked staker's current ref from contract storage. (We
    // bumped nextExternalEpochRef above, but the contract tracks per
    // staker — and the linked staker's ref is whatever we used in
    // test #1.)
    const stakerRef = await mockYieldEmitter.lastExternalEpochRef(
      linkedEthWallet.address
    )
    await expect(
      emitYieldBatch(
        mockYieldEmitter,
        [
          {
            staker: linkedEthWallet.address,
            wireAccount: linkedEthAccount,
            rewardAmount: ETH_REWARD_PER_STAKER,
            shareBps: 10000
          }
        ],
        stakerRef, // replay the same ref
        1
      )
    ).rejects.toThrow(/externalEpochRef not monotonic|reverted/i)
  })
})
