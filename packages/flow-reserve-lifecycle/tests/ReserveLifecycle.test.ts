import "jest"
import { ethers } from "ethers"
import {
  ETHBootstrapper,
  FlowTestContext,
  log,
  pollUntil,
  ProcessManager,
  createAuthExLink,
  emPrivateKeyFromEthWallet,
  ensureSwapUserIdentities,
  provisionWireUser,
  requestEthereumSwap,
  resolveLatestNonce,
  SwapUserIdentities,
  WireUser
} from "@wireio/test-cluster-tool"
import { ChainKind } from "@wireio/opp-typescript-models"
import { SlugName, SystemContracts } from "@wireio/sdk-core"
import {
  Timing,
  Reserves,
  CreateParams,
  SwapProbe,
  FromWireProbe,
  Accounts,
  EthAllowances,
  HdIndices,
  EthLocalReserveStatus
} from "./constants.js"

/**
 * Flow: gated reserve create→match lifecycle + private-reserve exclusions.
 *
 * The depot (`sysio.reserv`) gates post-bootstrap reserve creation on the
 * creator's authex link and activation on a REAL WIRE match:
 *
 * - An outpost `create_reserve` ships `isPrivate` + the creator's pubkey
 *   (33-byte compressed secp256k1 on ETH, contract-verified to derive to
 *   `msg.sender`). The depot inserts a PENDING row when the creator is
 *   authex-linked; an unlinked creator gets a CANCELLED row + a
 *   RESERVE_CREATE_CANCELLED round-trip that refunds the outpost escrow.
 * - `matchreserve` requires the matcher to be THE WIRE account
 *   authex-linked to the creator's key, escrows `wire_amount` REAL WIRE
 *   (matcher → sysio.reserv custody), flips the row ACTIVE, records
 *   `owner = matcher`, and queues RESERVE_READY back to the outpost.
 * - Private reserves are excluded from everything except same-owner
 *   private pairs: a private↔public pairing draws a SWAP_REVERT (no
 *   UWREQ row is ever created) and WIRE-endpoint swaps touching one are
 *   rejected (`swapfromwire` asserts at push).
 *
 * ETH-side only — the SOL create path is exercised by
 * `flow-swap-private-reserves`.
 */
describe("Flow: gated reserve create→match lifecycle + private-reserve exclusions", () => {
  let context: FlowTestContext
  let users: SwapUserIdentities
  let matcher: WireUser
  let wrongMatcher: WireUser
  let reserveManager: ethers.Contract

  const slugValue = (v: unknown): number =>
    typeof v === "object" && v !== null && "value" in v
      ? Number((v as { value: unknown }).value)
      : Number(v)

  /**
   * Depot reserve-row status check tolerant of both wire shapes — the v6
   * KV read may surface the proto enum as its numeric value or its
   * string spelling (enum reverse mapping covers the latter).
   */
  const reserveStatusIs = (
    row: any,
    expected: SystemContracts.SysioReservReservestatus
  ): boolean =>
    Number(row?.status) === expected ||
    row?.status === SystemContracts.SysioReservReservestatus[expected]

  /** The depot reserve row for an (chain, token, reserve) triple. */
  async function reserveRow(
    chainCode: number,
    tokenCode: number,
    reserveCode: number
  ): Promise<any> {
    const { rows } = await context.wireClient.getTableRows<any>({
      code: "sysio.reserv", scope: "sysio.reserv", table: "reserves"
    })
    return rows.find((r: any) =>
      slugValue(r.chain_code) === chainCode &&
      slugValue(r.token_code) === tokenCode &&
      slugValue(r.reserve_code) === reserveCode
    )
  }

  /** The forbidden UWREQ — anything sourcing the private ETH reserve. */
  async function privateSourcedUwreq(): Promise<any> {
    const { rows } = await context.wireClient.getTableRows<any>({
      code: "sysio.uwrit", scope: "sysio.uwrit", table: "uwreqs"
    })
    return rows.find((r: any) =>
      slugValue(r.src_chain_code) === Reserves.Ethereum.ChainCode &&
      slugValue(r.src_reserve_code) === Reserves.Ethereum.PrivateReserveCode
    )
  }

  beforeAll(async () => {
    context = await FlowTestContext.create({
      epochDurationSec: Timing.EpochDurationSec,
      reqUwCollat: [
        {
          chainCode: SlugName.from("ETHEREUM"),
          tokenCode: SlugName.from("ETH"),
          minBond: 1_000_000_000
        },
        {
          chainCode: SlugName.from("SOLANA"),
          tokenCode: SlugName.from("SOL"),
          minBond: 1_000_000_000
        }
      ]
    })
    users = await ensureSwapUserIdentities(context)

    // The matcher escrows real WIRE on activation; the wrong matcher is
    // funded identically so ONLY the missing authex link explains (b).
    matcher = await provisionWireUser(context.wireClient.clio, Accounts.Matcher, {
      fundWireAmount: Accounts.MatcherFunding
    })
    wrongMatcher = await provisionWireUser(context.wireClient.clio, Accounts.WrongMatcher, {
      fundWireAmount: Accounts.WrongMatcherFunding
    })

    // Bind the matcher to the creator wallet's secp256k1 key. The depot's
    // `oncrtreserve` accepts the create because the CREATOR key has a
    // link; `matchreserve` later requires the MATCHER's link key to equal
    // the creator key — this single link satisfies both sides.
    await createAuthExLink(context.wireClient.clio, {
      chainKind: ChainKind.EVM,
      account: Accounts.Matcher,
      privateKey: emPrivateKeyFromEthWallet(users.ethereumWallet),
      ethWallet: users.ethereumWallet
    })

    const ethAddrs = context.loadETHAddresses()
    reserveManager = context.loadETHContract("ReserveManager", ethAddrs.ReserveManager)
      .connect(users.ethereumWallet) as ethers.Contract
  }, Timing.BootstrapTimeoutMs)

  afterAll(async () => {
    try {
      await context?.teardown()
    } catch (err) {
      log.error("Error during teardown:", err)
    }
    await ProcessManager.get().killAll()
  }, 30_000)

  // ── Phase 0: substrate health ───────────────────────────────────────────

  test("WIRE chain is producing blocks", async () => {
    const info = await context.wireClient.getInfo()
    expect(Number(info.head_block_num)).toBeGreaterThan(0)
  })

  test("bootstrap seeded the SOLANA/SOL/PRIMARY public counterpart", async () => {
    // (f) pairs the private reserve against this public reserve — it must
    // exist so the rejection is attributable to privacy, not absence.
    const row = await reserveRow(
      Reserves.Solana.ChainCode,
      Reserves.Solana.TokenCode,
      Reserves.Solana.ReserveCode
    )
    expect(row).toBeDefined()
  })

  // ── The gated create→match lifecycle ────────────────────────────────────

  test("linked creator's create_reserve lands a PENDING depot row carrying the creator pubkey", async () => {
    const nonce = await resolveLatestNonce(reserveManager as unknown as ethers.BaseContract)
    const tx = await reserveManager.create_reserve(
      BigInt(Reserves.Ethereum.TokenCode),
      BigInt(Reserves.Ethereum.PrivateReserveCode),
      CreateParams.PrivateEscrowWei,
      CreateParams.RequestedWireAmount,
      CreateParams.ConnectorWeightBps,
      CreateParams.PrivateName,
      CreateParams.PrivateDescription,
      true,
      users.ethereumWallet.signingKey.compressedPublicKey,
      { value: CreateParams.PrivateEscrowWei, nonce }
    )
    const receipt = await tx.wait(1)
    expect(receipt?.status).toBe(1)

    await pollUntil(
      "PRIVRES depot row status=PENDING",
      async () => {
        const row = await reserveRow(
          Reserves.Ethereum.ChainCode,
          Reserves.Ethereum.TokenCode,
          Reserves.Ethereum.PrivateReserveCode
        )
        return row !== undefined &&
          reserveStatusIs(row, SystemContracts.SysioReservReservestatus.RESERVE_STATUS_PENDING)
      },
      Timing.RelayDeadlineMs,
      Timing.LongPollIntervalMs
    )

    const row = await reserveRow(
      Reserves.Ethereum.ChainCode,
      Reserves.Ethereum.TokenCode,
      Reserves.Ethereum.PrivateReserveCode
    )
    // The privacy flag + the normalized creator key both ride the create
    // attestation and land verbatim on the depot row.
    expect(row.is_private === true || Number(row.is_private) === 1).toBe(true)
    expect(typeof row.creator_pub_key).toBe("string")
    expect(row.creator_pub_key.length).toBeGreaterThan(0)
  }, Timing.RelayDeadlineMs + 30_000)

  test("matchreserve from a non-linked account is rejected", async () => {
    // wrongmatchr passes every pre-check (row PENDING, exact wire_amount)
    // so the failure is attributable to the missing authex link alone.
    await expect(
      context.wireClient.clio.pushActionAndWait<SystemContracts.SysioReservMatchreserveAction>(
        "sysio.reserv",
        "matchreserve",
        {
          chain_code: { value: Reserves.Ethereum.ChainCode },
          token_code: { value: Reserves.Ethereum.TokenCode },
          reserve_code: { value: Reserves.Ethereum.PrivateReserveCode },
          matcher: wrongMatcher.account,
          wire_amount: Number(CreateParams.RequestedWireAmount)
        },
        `${wrongMatcher.account}@active`
      )
    ).rejects.toThrow(/matcher has no authex link/)
  })

  test("the authex-linked matcher activates the reserve with real WIRE escrow", async () => {
    const custodyBefore = await context.wireClient.getWireBalance("sysio.reserv")
    const matcherBefore = await context.wireClient.getWireBalance(matcher.account)
    expect(matcherBefore).toBeGreaterThanOrEqual(CreateParams.RequestedWireAmount)

    await context.wireClient.clio.pushActionAndWait<SystemContracts.SysioReservMatchreserveAction>(
      "sysio.reserv",
      "matchreserve",
      {
        chain_code: { value: Reserves.Ethereum.ChainCode },
        token_code: { value: Reserves.Ethereum.TokenCode },
        reserve_code: { value: Reserves.Ethereum.PrivateReserveCode },
        matcher: matcher.account,
        wire_amount: Number(CreateParams.RequestedWireAmount)
      },
      `${matcher.account}@active`
    )

    await pollUntil(
      "PRIVRES depot row status=ACTIVE",
      async () => {
        const row = await reserveRow(
          Reserves.Ethereum.ChainCode,
          Reserves.Ethereum.TokenCode,
          Reserves.Ethereum.PrivateReserveCode
        )
        return row !== undefined &&
          reserveStatusIs(row, SystemContracts.SysioReservReservestatus.RESERVE_STATUS_ACTIVE)
      },
      Timing.ReadyDeadlineMs,
      Timing.LongPollIntervalMs
    )

    const row = await reserveRow(
      Reserves.Ethereum.ChainCode,
      Reserves.Ethereum.TokenCode,
      Reserves.Ethereum.PrivateReserveCode
    )
    expect(row.owner).toBe(matcher.account)
    expect(BigInt(row.reserve_wire_amount)).toBe(CreateParams.RequestedWireAmount)

    // The match IS a WIRE deposit — custody up, matcher down, exactly.
    const custodyAfter = await context.wireClient.getWireBalance("sysio.reserv")
    const matcherAfter = await context.wireClient.getWireBalance(matcher.account)
    expect(custodyAfter).toBe(custodyBefore + CreateParams.RequestedWireAmount)
    expect(matcherAfter).toBe(matcherBefore - CreateParams.RequestedWireAmount)
  }, Timing.ReadyDeadlineMs + 30_000)

  test("RESERVE_READY flips the outpost-local record ACTIVE", async () => {
    await pollUntil(
      "outpost-local PRIVRES record ACTIVE",
      async () => {
        const rec = await reserveManager.getReserve(
          BigInt(Reserves.Ethereum.TokenCode),
          BigInt(Reserves.Ethereum.PrivateReserveCode)
        )
        return Number(rec.status) === EthLocalReserveStatus.ACTIVE
      },
      Timing.ReadyDeadlineMs,
      Timing.LongPollIntervalMs
    )
  }, Timing.ReadyDeadlineMs + 30_000)

  test("an unlinked creator's create is cancelled back and refunded", async () => {
    // A fresh wallet one HD slot past the swap user — funded for gas +
    // escrow but NEVER authex-linked, so the depot must cancel back.
    const noLinkWallet = ethers.HDNodeWallet.fromMnemonic(
      ethers.Mnemonic.fromPhrase(ETHBootstrapper.AnvilMnemonic),
      `${ETHBootstrapper.DerivationPath}${HdIndices.NoLinkCreator}`
    ).connect(context.ethProvider)
    const funder = await context.ethProvider.getSigner(0)
    const fundTx = await funder.sendTransaction({
      to: noLinkWallet.address,
      value: EthAllowances.NoLinkWalletFundingWei
    })
    await fundTx.wait()

    const preCreateBalance = await context.ethProvider.getBalance(noLinkWallet.address)

    const noLinkReserveManager = reserveManager.connect(noLinkWallet) as ethers.Contract
    const nonce = await resolveLatestNonce(noLinkReserveManager as unknown as ethers.BaseContract)
    const tx = await noLinkReserveManager.create_reserve(
      BigInt(Reserves.Ethereum.TokenCode),
      BigInt(Reserves.Ethereum.NoLinkReserveCode),
      CreateParams.NoLinkEscrowWei,
      CreateParams.RequestedWireAmount,
      CreateParams.ConnectorWeightBps,
      CreateParams.NoLinkName,
      CreateParams.NoLinkDescription,
      false,
      noLinkWallet.signingKey.compressedPublicKey,
      { value: CreateParams.NoLinkEscrowWei, nonce }
    )
    const receipt = await tx.wait(1)
    expect(receipt?.status).toBe(1)

    // The depot rejects by inserting a CANCELLED row (audit trail) and
    // queueing RESERVE_CREATE_CANCELLED back to the outpost.
    await pollUntil(
      "NOLINKRS depot row status=CANCELLED",
      async () => {
        const row = await reserveRow(
          Reserves.Ethereum.ChainCode,
          Reserves.Ethereum.TokenCode,
          Reserves.Ethereum.NoLinkReserveCode
        )
        return row !== undefined &&
          reserveStatusIs(row, SystemContracts.SysioReservReservestatus.RESERVE_STATUS_CANCELLED)
      },
      Timing.RelayDeadlineMs,
      Timing.LongPollIntervalMs
    )

    // Refund on the inbound RESERVE_CREATE_CANCELLED: the escrow returns,
    // leaving only create-tx gas unrecovered.
    const refundFloor = preCreateBalance - EthAllowances.RefundGasAllowanceWei
    await pollUntil(
      "NOLINKRS creator escrow refunded",
      async () =>
        (await context.ethProvider.getBalance(noLinkWallet.address)) > refundFloor,
      Timing.ReadyDeadlineMs,
      Timing.LongPollIntervalMs
    )

    // And the outpost-local mirror flips CANCELLED in the same dispatch.
    await pollUntil(
      "outpost-local NOLINKRS record CANCELLED",
      async () => {
        const rec = await noLinkReserveManager.getReserve(
          BigInt(Reserves.Ethereum.TokenCode),
          BigInt(Reserves.Ethereum.NoLinkReserveCode)
        )
        return Number(rec.status) === EthLocalReserveStatus.CANCELLED
      },
      Timing.ReadyDeadlineMs,
      Timing.LongPollIntervalMs
    )
  }, Timing.RelayDeadlineMs + 2 * Timing.ReadyDeadlineMs + 60_000)

  test("a private reserve cannot pair with a public counterpart (SWAP_REVERT, no uwreq)", async () => {
    // The privacy gate precedes the variance check on the depot, so the
    // sentinel target never reaches the quote comparison — the swap is
    // rejected with SWAP_REVERT and NO uwreq row is ever created.
    const result = await requestEthereumSwap(reserveManager as any, {
      sourceTokenCode:    BigInt(Reserves.Ethereum.TokenCode),
      sourceReserveCode:  BigInt(Reserves.Ethereum.PrivateReserveCode),
      sourceAmountWei:    SwapProbe.SourceEthereumWei,
      targetChainCode:    BigInt(Reserves.Solana.ChainCode),
      targetTokenCode:    BigInt(Reserves.Solana.TokenCode),
      targetReserveCode:  BigInt(Reserves.Solana.ReserveCode),
      targetRecipient:    users.solanaPublicKeyBytes,
      targetAmount:       SwapProbe.TargetAmount,
      targetToleranceBps: SwapProbe.ToleranceBps
    })
    expect(result.transactionHash).toBeTruthy()

    // Inverted poll: the forbidden UWREQ must NOT appear inside the
    // window — `pollUntil` throwing its deadline error IS the pass.
    await expect(
      pollUntil(
        "forbidden PRIVRES-sourced UWREQ",
        async () => (await privateSourcedUwreq()) !== undefined,
        Timing.NoUwreqWindowMs,
        Timing.LongPollIntervalMs
      )
    ).rejects.toThrow(/Timed out/)
  }, Timing.NoUwreqWindowMs + 60_000)

  test("swapfromwire targeting a private reserve is rejected at submit", async () => {
    // WIRE-endpoint exclusion is symmetric: an outbound from-WIRE swap
    // aimed AT a private reserve asserts at push (the reserve is ACTIVE,
    // so the privacy check is the one that fires).
    await expect(
      context.wireClient.clio.pushActionAndWait<SystemContracts.SysioUwritSwapfromwireAction>(
        "sysio.uwrit",
        "swapfromwire",
        {
          user: matcher.account,
          wire_amount: Number(FromWireProbe.WireAmount),
          dst_chain_code: { value: Reserves.Ethereum.ChainCode },
          dst_token_code: { value: Reserves.Ethereum.TokenCode },
          dst_reserve_code: { value: Reserves.Ethereum.PrivateReserveCode },
          target_amount: Number(FromWireProbe.TargetAmount),
          target_tolerance_bps: FromWireProbe.ToleranceBps,
          recipient_kind: SystemContracts.SysioUwritChainkind.CHAIN_KIND_EVM,
          recipient_addr: Buffer.from(users.ethereumAddressBytes).toString("hex")
        },
        `${matcher.account}@active`
      )
    ).rejects.toThrow(/private reserves are excluded from WIRE-endpoint swaps/)
  })
})
