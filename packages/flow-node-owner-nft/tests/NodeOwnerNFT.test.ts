import "jest"
import * as Fs from "node:fs"
import * as Path from "node:path"

import {
  DEV_K1_PUBLIC_KEY,
  FlowTestContext,
  freshEthPubEm,
  loadMockWireNodes,
  log,
  mintNodeNFT,
  MockWireNodesContract,
  NodeOwnerRejectReason,
  NodeOwnerRegStatus,
  NodeOwnerTier,
  pushNewNamedUser,
  pushNodeOwnerReg,
  readNodeOwner,
  readNodeOwnerReg
} from "@wireio/test-cluster-tool"

/**
 * Flow: ERC-1155 mint → sysio.roa create-in-flow node-owner registration.
 *
 * The depot (sysio.msgch) decodes an inbound OPP NodeOwnerRegistration and inline-sends
 * sysio.roa::newnameduser (create the account from the claim's Wire key) then ::nodeownreg
 * (register + inline-record the depositor's ETH link in sysio.authex). This flow drives those two
 * roa actions directly, as the depot inline-sends them, and exercises every outcome:
 *
 *   1. happy path                     — create + register → nodeowners row + CONFIRMED audit
 *   2. wrong Wire key                 — existing account, different key → REJECTED/ACCOUNT_KEY_MISMATCH
 *   3. name invalid for tier          — tier-1 name > 6 chars → REJECTED/NAME_INVALID
 *   4. owner not an account           — valid name, never created → REJECTED/OWNER_NOT_ACCOUNT
 *   5. already registered             — replay → REJECTED/DUPLICATE
 *   6. tier 0 / tier 4                — hard abort "Tier level must be between 1 and 3"
 *   7. non-EM (K1) eth key            — hard abort "must be an EM (secp256k1) public key"
 *   8. (decorative) MockWireNodes mint succeeds and bumps totalSupply — the production flow would
 *      observe this TransferSingle to build the NodeOwnerRegistration attestation.
 *
 * Claim-payload problems (2-5) soft-fail into a nodeownerreg audit row rather than throwing
 * (trust-OPP); only depot/system invariants (6-7) hard-abort.
 *
 * Cluster data dir: the standard fresh-mode `WIRE_CLUSTER_PATH` (resolved by FlowTestContext.create),
 * identical to every other gate flow -- no bespoke `WIRE_CHAIN_DIR` / `/mnt/data`.
 */

const EPOCH_DURATION_SEC = Number(process.env.EPOCH_DURATION_SEC ?? 60)

// A second, distinct Wire K1 key (from `clio create key --k1`) for the wrong-key case.
const OTHER_WIRE_KEY = "PUB_K1_84yPGCSNRdSTrdpYnfzWun477PzuKR4L4R8eYumxqLjoG8s2Jo"

// `describe.skip` for unit-only environments — the flow needs a real nodeop cluster, anvil, and the
// wire-sysio build path on disk.
const describeCluster = process.env.WIRE_BUILD_PATH ? describe : describe.skip

describeCluster("Node owner NFT registration (create-in-flow)", () => {
  let ctx: FlowTestContext
  let mockWireNodes: MockWireNodesContract
  let outpostAddrs: Record<string, string>

  beforeAll(async () => {
    ctx = await FlowTestContext.create({
      epochDurationSec: EPOCH_DURATION_SEC,
      producerCount: 3,
      batchOperatorCount: 3,
      underwriterCount: 1
    })

    const ethereumPath = ctx.ethereumPath
    expect(ethereumPath).toBeTruthy()
    const outpostAddrsPath = Path.join(ethereumPath, ".local", "deployments", "outpost-addrs.json")
    outpostAddrs = JSON.parse(Fs.readFileSync(outpostAddrsPath, "utf-8"))
    mockWireNodes = loadMockWireNodes(ethereumPath, outpostAddrs, ctx.ethSigner)

    // kiod is restarted between cluster create + run; open + unlock so clio can sign sysio.roa@active.
    await ctx.wireClient.clio.walletOpenAndUnlock("default")
  }, 30 * 60 * 1000)

  afterAll(async () => {
    try {
      await ctx?.teardown()
    } catch (err) {
      log.error("[node-owner-nft] teardown error:", err)
    }
  }, 5 * 60 * 1000)

  // ──────────────────────────────────────────────────────────────────────
  // 1. Happy path — create the account with the holder's key, then register it.
  // ──────────────────────────────────────────────────────────────────────
  it("creates the account and registers the owner at the requested tier", async () => {
    const account = "nfta"
    await pushNewNamedUser(ctx.wireClient.clio, account, DEV_K1_PUBLIC_KEY, NodeOwnerTier.T1)
    await pushNodeOwnerReg(ctx.wireClient.clio, account, NodeOwnerTier.T1, freshEthPubEm(), DEV_K1_PUBLIC_KEY)

    const reg = await readNodeOwner(ctx.wireClient.clio, account)
    expect(reg).toBeDefined()
    expect(Number(reg!.tier)).toBe(NodeOwnerTier.T1)
    const audit = await readNodeOwnerReg(ctx.wireClient.clio, account)
    expect(Number(audit?.status)).toBe(NodeOwnerRegStatus.Confirmed)
  })

  // ──────────────────────────────────────────────────────────────────────
  // 2. Existing account controlled by a different key → soft-fail ACCOUNT_KEY_MISMATCH.
  // ──────────────────────────────────────────────────────────────────────
  it("soft-fails when the account is controlled by a different key", async () => {
    const account = "nftb"
    await pushNewNamedUser(ctx.wireClient.clio, account, DEV_K1_PUBLIC_KEY, NodeOwnerTier.T1)
    // Claim with a Wire key the account is NOT controlled by.
    await pushNodeOwnerReg(ctx.wireClient.clio, account, NodeOwnerTier.T1, freshEthPubEm(), OTHER_WIRE_KEY)

    expect(await readNodeOwner(ctx.wireClient.clio, account)).toBeUndefined()
    const audit = await readNodeOwnerReg(ctx.wireClient.clio, account)
    expect(Number(audit?.status)).toBe(NodeOwnerRegStatus.Rejected)
    expect(Number(audit?.reason)).toBe(NodeOwnerRejectReason.AccountKeyMismatch)
  })

  // ──────────────────────────────────────────────────────────────────────
  // 3. Name invalid for tier (tier-1 owner names must be a 2-6 char prefix) → NAME_INVALID.
  // ──────────────────────────────────────────────────────────────────────
  it("soft-fails a tier-1 name longer than the prefix budget", async () => {
    const account = "toolongname" // 11 chars: valid charset, too long for tier 1
    await pushNodeOwnerReg(ctx.wireClient.clio, account, NodeOwnerTier.T1, freshEthPubEm(), DEV_K1_PUBLIC_KEY)

    expect(await readNodeOwner(ctx.wireClient.clio, account)).toBeUndefined()
    const audit = await readNodeOwnerReg(ctx.wireClient.clio, account)
    expect(Number(audit?.status)).toBe(NodeOwnerRegStatus.Rejected)
    expect(Number(audit?.reason)).toBe(NodeOwnerRejectReason.NameInvalid)
  })

  // ──────────────────────────────────────────────────────────────────────
  // 4. Valid-for-tier name that was never created → OWNER_NOT_ACCOUNT.
  // ──────────────────────────────────────────────────────────────────────
  it("soft-fails when the owner account does not exist", async () => {
    const account = "ghost" // 5 chars: valid for tier 1, but never created
    await pushNodeOwnerReg(ctx.wireClient.clio, account, NodeOwnerTier.T1, freshEthPubEm(), DEV_K1_PUBLIC_KEY)

    expect(await readNodeOwner(ctx.wireClient.clio, account)).toBeUndefined()
    const audit = await readNodeOwnerReg(ctx.wireClient.clio, account)
    expect(Number(audit?.status)).toBe(NodeOwnerRegStatus.Rejected)
    expect(Number(audit?.reason)).toBe(NodeOwnerRejectReason.OwnerNotAccount)
  })

  // ──────────────────────────────────────────────────────────────────────
  // 5. Replay → soft-fail DUPLICATE.
  // ──────────────────────────────────────────────────────────────────────
  it("soft-fails a second registration for the same owner", async () => {
    const account = "nftd"
    await pushNewNamedUser(ctx.wireClient.clio, account, DEV_K1_PUBLIC_KEY, NodeOwnerTier.T1)
    await pushNodeOwnerReg(ctx.wireClient.clio, account, NodeOwnerTier.T1, freshEthPubEm(), DEV_K1_PUBLIC_KEY)
    await pushNodeOwnerReg(ctx.wireClient.clio, account, NodeOwnerTier.T2, freshEthPubEm(), DEV_K1_PUBLIC_KEY)

    const audit = await readNodeOwnerReg(ctx.wireClient.clio, account)
    expect(Number(audit?.status)).toBe(NodeOwnerRegStatus.Rejected)
    expect(Number(audit?.reason)).toBe(NodeOwnerRejectReason.Duplicate)
  })

  // ──────────────────────────────────────────────────────────────────────
  // 6. Invalid tier — depot/system invariant → hard abort.
  // ──────────────────────────────────────────────────────────────────────
  it("hard-aborts tier 0 and tier 4", async () => {
    const account = "nfte"
    await pushNewNamedUser(ctx.wireClient.clio, account, DEV_K1_PUBLIC_KEY, NodeOwnerTier.T1)
    await expect(
      pushNodeOwnerReg(ctx.wireClient.clio, account, 0 as unknown as NodeOwnerTier, freshEthPubEm(), DEV_K1_PUBLIC_KEY)
    ).rejects.toThrow(/Tier level must be between 1 and 3/)
    await expect(
      pushNodeOwnerReg(ctx.wireClient.clio, account, 4 as unknown as NodeOwnerTier, freshEthPubEm(), DEV_K1_PUBLIC_KEY)
    ).rejects.toThrow(/Tier level must be between 1 and 3/)
  })

  // ──────────────────────────────────────────────────────────────────────
  // 7. Non-EM eth key — depot invariant → hard abort.
  // ──────────────────────────────────────────────────────────────────────
  it("hard-aborts a non-EM (K1) eth key", async () => {
    const account = "nftf"
    await pushNewNamedUser(ctx.wireClient.clio, account, DEV_K1_PUBLIC_KEY, NodeOwnerTier.T1)
    await expect(
      // DEV_K1_PUBLIC_KEY is a K1 key passed where an EM key is required.
      pushNodeOwnerReg(ctx.wireClient.clio, account, NodeOwnerTier.T1, DEV_K1_PUBLIC_KEY, DEV_K1_PUBLIC_KEY)
    ).rejects.toThrow(/EM \(secp256k1\) public key/)
  })

  // ──────────────────────────────────────────────────────────────────────
  // 8. MockWireNodes sanity — the ERC-1155 surface the production flow observes.
  // ──────────────────────────────────────────────────────────────────────
  it("MockWireNodes accepts a tier-1 mint at 1 ether", async () => {
    const before = await mockWireNodes.viewTotalSupply(NodeOwnerTier.T1)
    const receipt = await mintNodeNFT(mockWireNodes, NodeOwnerTier.T1, 1)
    expect(receipt.status).toBe(1)
    const after = await mockWireNodes.viewTotalSupply(NodeOwnerTier.T1)
    expect(after - before).toBe(1n)
    const minterBal = await mockWireNodes.balanceOf(await ctx.ethSigner.getAddress(), NodeOwnerTier.T1)
    expect(minterBal).toBeGreaterThanOrEqual(1n)
  })
})
