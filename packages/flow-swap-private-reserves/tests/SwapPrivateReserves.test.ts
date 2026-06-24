import "jest"
import * as anchor from "@coral-xyz/anchor"
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js"
import {
  TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync
} from "@solana/spl-token"
import { ethers } from "ethers"
import {
  FlowTestContext,
  log,
  pollUntil,
  ProcessManager,
  createAuthExLink,
  emPrivateKeyFromEthWallet,
  ensureSwapUserIdentities,
  mintMockSplToUser,
  provisionWireUser,
  requestEthereumSwap,
  requestSolanaSwapSpl,
  resolveLatestNonce,
  SwapUserIdentities,
  WireUser,
  WIREClient
} from "@wireio/test-cluster-tool"
import {
  ChainKind,
  TokenAmount,
  UnderwriteRequestStatus
} from "@wireio/opp-typescript-models"
import {
  Bytes,
  KeyType,
  PrivateKey,
  SlugName,
  SystemContracts
} from "@wireio/sdk-core"
import * as Fs from "node:fs"
import * as Path from "node:path"
import {
  Timing,
  Reserves,
  CreateParams,
  SwapAmounts,
  Variance,
  Accounts,
  SplFunding,
  WireProbe,
  EthLocalReserveStatus
} from "./constants.js"

/** PDA seeds — kept in sync with `wire-solana/programs/opp-outpost/src`. */
const OUTPOST_CONFIG_SEED          = Buffer.from("outpost_config")
const OUTBOUND_MESSAGE_BUFFER_SEED = Buffer.from("outbound_message_buffer")
const RESERVE_SEED                 = Buffer.from("reserve")
const RESERVE_VAULT_SEED           = Buffer.from("reserve_vault")

/** Number of ms to poll `getSignatureStatus` before timing out. */
const SOL_CONFIRM_TIMEOUT_MS = 60_000
const SOL_CONFIRM_POLL_MS    = 500

/**
 * Flow: bidirectional swaps through a same-owner PRIVATE reserve pair
 * (native × non-native) + private→WIRE exclusion.
 *
 * The FINAL verification flow for the gated-reserve feature: both private
 * reserves are stood up via the REAL handshake — outpost `create_reserve`
 * (ETH native / SOL USDCSOL SPL, `isPrivate=true`) → depot PENDING row →
 * `matchreserve` by the single authex-linked owner (`privowner`, linked
 * on BOTH chains) escrowing real WIRE → ACTIVE with `owner = privowner` →
 * RESERVE_READY flips both outpost-local records.
 *
 * Because both reserves share one non-empty owner, the depot's privacy
 * gate ADMITS the pair: Phase A swaps native ETH → USDCSOL (SPL payout to
 * the user's ATA) and Phase B swaps USDCSOL → native ETH, each through
 * the standard UWREQ race (two legs ⇒ two locks) with the emit-time
 * four-leg constant-product books asserted with exact integers. The
 * WIRE-endpoint exclusion still binds: a swap sourcing the private ETH
 * reserve toward WIRE draws a SWAP_REVERT and never creates a UWREQ.
 */
describe("Flow: bidirectional swaps through a same-owner PRIVATE reserve pair", () => {
  let context: FlowTestContext
  let users: SwapUserIdentities
  let owner: WireUser
  let reserveManager: ethers.Contract
  let oppProgram: anchor.Program<anchor.Idl>
  let solanaConnection: Connection
  let usdcSolMint: PublicKey
  let solDeployer: Keypair
  let userUsdcSolAta: PublicKey

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

  /** The depot reserve row for a (chain, token, reserve) triple. */
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

  /** The private ETH-side depot row. */
  const ethPrivateRow = () =>
    reserveRow(
      Reserves.Ethereum.ChainCode,
      Reserves.Ethereum.TokenCode,
      Reserves.PrivateReserveCode
    )

  /** The private SOL-side depot row. */
  const solPrivateRow = () =>
    reserveRow(
      Reserves.Solana.ChainCode,
      Reserves.Solana.TokenCode,
      Reserves.PrivateReserveCode
    )

  /** The UWREQ sourcing `srcReserveCode` on `srcChainCode` toward `dstChainCode`. */
  async function uwreqMatching(
    srcChainCode: number,
    srcReserveCode: number,
    dstChainCode: number
  ): Promise<any> {
    const { rows } = await context.wireClient.getTableRows<any>({
      code: "sysio.uwrit", scope: "sysio.uwrit", table: "uwreqs"
    })
    return rows.find((r: any) =>
      slugValue(r.src_chain_code) === srcChainCode &&
      slugValue(r.src_reserve_code) === srcReserveCode &&
      slugValue(r.dst_chain_code) === dstChainCode
    )
  }

  async function locksForUwreq(uwreqId: number): Promise<any[]> {
    const { rows } = await context.wireClient.getTableRows<any>({
      code: "sysio.uwrit", scope: "sysio.uwrit", table: "locks"
    })
    return rows.filter((l: any) => Number(l.uwreq_id) === uwreqId)
  }

  /** True when a UWREQ row is in the CONFIRMED state (either wire shape). */
  const uwreqConfirmed = (row: any): boolean =>
    row !== undefined &&
    (Number(row.status) === UnderwriteRequestStatus.CONFIRMED ||
      row.status === "UNDERWRITE_REQUEST_STATUS_CONFIRMED")

  /** Push `sysio.reserv::matchreserve` as the owner for one triple. */
  async function pushMatchReserve(
    chainCode: number,
    tokenCode: number,
    reserveCode: number,
    wireAmount: bigint
  ): Promise<void> {
    await context.wireClient.clio.pushActionAndWait<SystemContracts.SysioReservMatchreserveAction>(
      "sysio.reserv",
      "matchreserve",
      {
        chain_code: { value: chainCode },
        token_code: { value: tokenCode },
        reserve_code: { value: reserveCode },
        matcher: owner.account,
        wire_amount: Number(wireAmount)
      },
      `${owner.account}@active`
    )
  }

  /**
   * Submit the ETH-native `create_reserve` for the private ETH reserve —
   * escrows `msg.value` wei and ships the creator's compressed secp256k1
   * key (contract-verified to derive to the caller).
   */
  async function createEthereumPrivateReserve(): Promise<void> {
    const nonce = await resolveLatestNonce(reserveManager as unknown as ethers.BaseContract)
    const tx = await reserveManager.create_reserve(
      BigInt(Reserves.Ethereum.TokenCode),
      BigInt(Reserves.PrivateReserveCode),
      CreateParams.EthereumEscrowWei,
      CreateParams.EthereumRequestedWire,
      CreateParams.ConnectorWeightBps,
      CreateParams.EthereumName,
      CreateParams.EthereumDescription,
      true,
      users.ethereumWallet.signingKey.compressedPublicKey,
      { value: CreateParams.EthereumEscrowWei, nonce }
    )
    const receipt = await tx.wait(1)
    if (receipt?.status !== 1) {
      throw new Error("create_reserve(ETH/PRIVATE) reverted")
    }
  }

  /**
   * Submit the permissionless SPL-branch `create_reserve` IX for the
   * private USDCSOL reserve. Accounts mirror the program's
   * `CreateReserve` struct (`create_reserve.rs`): the per-reserve PDA +
   * vault are `init`-allocated here, the escrow transfers from the
   * creator's ATA into the vault, and the signer's ed25519 key rides the
   * attestation as `creator_pub_key` automatically.
   */
  async function createSolanaPrivateReserve(): Promise<void> {
    const programId                  = oppProgram.programId
    const [configPda]                = PublicKey.findProgramAddressSync([OUTPOST_CONFIG_SEED], programId)
    const [outboundMessageBufferPda] = PublicKey.findProgramAddressSync([OUTBOUND_MESSAGE_BUFFER_SEED], programId)
    const tokenCodeLE   = slugNameToLeBuffer(Reserves.Solana.TokenCode)
    const reserveCodeLE = slugNameToLeBuffer(Reserves.PrivateReserveCode)
    const [reservePda]      = PublicKey.findProgramAddressSync(
      [RESERVE_SEED, tokenCodeLE, reserveCodeLE], programId
    )
    const [reserveVaultPda] = PublicKey.findProgramAddressSync(
      [RESERVE_VAULT_SEED, tokenCodeLE, reserveCodeLE], programId
    )

    const tx = await oppProgram.methods
      .createReserve(
        new anchor.BN(Reserves.Solana.TokenCode),
        new anchor.BN(Reserves.PrivateReserveCode),
        new anchor.BN(CreateParams.SolanaEscrowChainUnits.toString()),
        new anchor.BN(CreateParams.SolanaRequestedWire.toString()),
        CreateParams.ConnectorWeightBps,
        CreateParams.SolanaName,
        CreateParams.SolanaDescription,
        true
      )
      .accounts({
        creator:               users.solanaKeypair.publicKey,
        config:                configPda,
        reserve:               reservePda,
        reserveVault:          reserveVaultPda,
        mint:                  usdcSolMint,
        creatorAta:            userUsdcSolAta,
        outboundMessageBuffer: outboundMessageBufferPda,
        tokenProgram:          TOKEN_PROGRAM_ID,
        systemProgram:         SystemProgram.programId,
        rent:                  anchor.web3.SYSVAR_RENT_PUBKEY
      })
      .signers([users.solanaKeypair])
      .transaction()
    await sendAndConfirmSolanaTx(
      solanaConnection, tx, users.solanaKeypair, "create_reserve(USDCSOL/PRIVATE)"
    )
  }

  /** True once the ETH outpost's local PRIVATE record reports ACTIVE. */
  async function ethLocalPrivateReserveActive(): Promise<boolean> {
    const rec = await reserveManager.getReserve(
      BigInt(Reserves.Ethereum.TokenCode),
      BigInt(Reserves.PrivateReserveCode)
    )
    return Number(rec.status) === EthLocalReserveStatus.ACTIVE
  }

  /**
   * True once the SOL outpost's PRIVATE Reserve PDA reports `Active`.
   * Required before Phase B — `request_swap_spl` constraint-gates on the
   * local status, so the RESERVE_READY round-trip must have landed.
   */
  async function solLocalPrivateReserveActive(): Promise<boolean> {
    const [reservePda] = PublicKey.findProgramAddressSync(
      [
        RESERVE_SEED,
        slugNameToLeBuffer(Reserves.Solana.TokenCode),
        slugNameToLeBuffer(Reserves.PrivateReserveCode)
      ],
      oppProgram.programId
    )
    const account = await (oppProgram.account as any).reserve.fetch(reservePda)
    const status = account?.status
    return typeof status === "object" && status !== null && "active" in status
  }

  beforeAll(async () => {
    // The depot's `createuwreq` re-checks `meets_role_min` for BOTH legs
    // of every swap, and the underwriter plugin's `select_coverable`
    // requires a non-zero credit-line bucket per (chain, token) — so the
    // underwriter must bond on every leg this flow's matrix touches:
    // native ETH, native SOL (bootstrap default deposits), and the
    // non-native USDCSOL leg.
    const uwCollatAmount = 1_000_000_000n
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
      ],
      underwriterCollateral: [[
        {
          chain_code: Reserves.Ethereum.ChainCode,
          amount: TokenAmount.create({
            tokenCode: BigInt(Reserves.Ethereum.TokenCode),
            amount:    uwCollatAmount
          })
        },
        {
          chain_code: Reserves.Solana.ChainCode,
          amount: TokenAmount.create({
            tokenCode: BigInt(Reserves.Solana.NativeTokenCode),
            amount:    uwCollatAmount
          })
        },
        {
          chain_code: Reserves.Solana.ChainCode,
          amount: TokenAmount.create({
            tokenCode: BigInt(Reserves.Solana.TokenCode),
            amount:    uwCollatAmount
          })
        }
      ]]
    })
    users = await ensureSwapUserIdentities(context)

    // ── The single owner — one WIRE account, authex-linked on BOTH chains ──
    // `matchreserve` requires the matcher's link key for the reserve's
    // chain to equal the creator key, so privowner links to the ETH
    // creator wallet's secp256k1 key AND the SOL creator keypair's
    // ed25519 key. Funded to cover both real-WIRE match escrows.
    owner = await provisionWireUser(context.wireClient.clio, Accounts.Owner, {
      fundWireAmount: Accounts.OwnerFunding
    })
    await createAuthExLink(context.wireClient.clio, {
      chainKind: ChainKind.EVM,
      account: Accounts.Owner,
      privateKey: emPrivateKeyFromEthWallet(users.ethereumWallet),
      ethWallet: users.ethereumWallet
    })
    // WIRE PrivateKey<ED> stores the full 64-byte secretKey (seed +
    // pubkey concat — the same shape as `Keypair.secretKey`), so the
    // SVM link regenerates from the keypair's full secret verbatim.
    const solSdkKey = PrivateKey.regenerate(
      KeyType.ED,
      Bytes.fromString(Buffer.from(users.solanaKeypair.secretKey).toString("hex"), "hex")
    )
    await createAuthExLink(context.wireClient.clio, {
      chainKind: ChainKind.SVM,
      account: Accounts.Owner,
      privateKey: solSdkKey
    })

    // ── ETH side: ReserveManager bound to the creator wallet ──
    const ethAddrs = context.loadETHAddresses()
    reserveManager = context.loadETHContract("ReserveManager", ethAddrs.ReserveManager)
      .connect(users.ethereumWallet) as ethers.Contract

    // ── SOL side: opp-outpost program + USDCSOL mock mint + deployer ──
    const solanaPath = context.solanaPath
    if (!solanaPath) {
      throw new Error("flow-swap-private-reserves requires WIRE_SOLANA_PATH")
    }
    const idlPath = Path.join(solanaPath, "target", "idl", "opp_outpost.json")
    const idl = JSON.parse(Fs.readFileSync(idlPath, "utf-8")) as anchor.Idl
    solanaConnection = new Connection(
      `http://127.0.0.1:${context.ports.solanaRpc}`,
      "confirmed"
    )
    const provider = new anchor.AnchorProvider(
      solanaConnection,
      new anchor.Wallet(users.solanaKeypair),
      { commitment: "confirmed" }
    )
    oppProgram = new anchor.Program(idl, provider)

    // The USDCSOL mock mint persisted by `SOLBootstrap.provisionSplReserves`.
    const splMintsFile = Path.join(context.clusterPath, "data", "sol-mock-mints.json")
    const splMints = JSON.parse(Fs.readFileSync(splMintsFile, "utf-8")) as Array<{
      code: number; mint: string; decimals: number
    }>
    const usdcEntry = splMints.find(m => m.code === Reserves.Solana.TokenCode)
    if (!usdcEntry) {
      throw new Error("Bootstrap did not persist the USDCSOL SPL mint")
    }
    usdcSolMint = new PublicKey(usdcEntry.mint)
    userUsdcSolAta = getAssociatedTokenAddressSync(usdcSolMint, users.solanaKeypair.publicKey)

    // Mint-authority deployer keypair persisted by `SOLBootstrap.bootstrap`.
    const deployerKeypairPath = Path.join(
      context.clusterPath, "data", "sol-deployer-keypair.json"
    )
    solDeployer = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(Fs.readFileSync(deployerKeypairPath, "utf-8")))
    )

    // Fund the creator's ATA with the create escrow + Phase B source.
    await mintMockSplToUser(
      solanaConnection,
      solDeployer,
      usdcSolMint,
      users.solanaKeypair.publicKey,
      SplFunding.CreatorMintAmount
    )

    // ── The real gated handshake, both chains ──
    // Submit both creates first so the two RESERVE_CREATE relays ride
    // their chains' envelope cadences concurrently.
    await createEthereumPrivateReserve()
    await createSolanaPrivateReserve()
    await pollUntil(
      "private depot rows (ETH + SOL) status=PENDING",
      async () => {
        const ethRow = await ethPrivateRow()
        const solRow = await solPrivateRow()
        return ethRow !== undefined &&
          reserveStatusIs(ethRow, SystemContracts.SysioReservReservestatus.RESERVE_STATUS_PENDING) &&
          solRow !== undefined &&
          reserveStatusIs(solRow, SystemContracts.SysioReservReservestatus.RESERVE_STATUS_PENDING)
      },
      Timing.RelayDeadlineMs,
      Timing.LongPollIntervalMs
    )

    // Match both as the single owner — flips the depot rows ACTIVE
    // synchronously and queues RESERVE_READY back to each outpost.
    await pushMatchReserve(
      Reserves.Ethereum.ChainCode,
      Reserves.Ethereum.TokenCode,
      Reserves.PrivateReserveCode,
      CreateParams.EthereumRequestedWire
    )
    await pushMatchReserve(
      Reserves.Solana.ChainCode,
      Reserves.Solana.TokenCode,
      Reserves.PrivateReserveCode,
      CreateParams.SolanaRequestedWire
    )

    // Wait for RESERVE_READY to land on BOTH outposts — Phase B's
    // `request_swap_spl` gates on the SOL PDA status, and the ETH local
    // flip proves the full round-trip on that side too.
    await pollUntil(
      "outpost-local private records ACTIVE (ETH + SOL)",
      async () =>
        (await ethLocalPrivateReserveActive()) &&
        (await solLocalPrivateReserveActive()),
      Timing.ReadyDeadlineMs,
      Timing.LongPollIntervalMs
    )
    log.info("[PrivatePair] both private reserves ACTIVE end-to-end")
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

  test("uwrit.a becomes ACTIVE (deposits credit)", async () => {
    await pollUntil(
      "uwrit.a ACTIVE",
      async () => {
        const { rows } = await context.wireClient.getTableRows<any>({
          code: "sysio.opreg", scope: "sysio.opreg", table: "operators"
        })
        const uw = rows.find((r: any) => r.account === "uwrit.a")
        if (!uw) return false
        return Number(uw.status) === 1 ||
          uw.status === "OPERATOR_STATUS_ACTIVE" ||
          uw.status === 1
      },
      Timing.UwreqDeadlineMs,
      Timing.LongPollIntervalMs
    )
  }, Timing.UwreqDeadlineMs + 30_000)

  test("both private rows are ACTIVE with owner=privowner and is_private=true", async () => {
    const ethRow = await ethPrivateRow()
    const solRow = await solPrivateRow()
    const rows = [ethRow, solRow]
    rows.forEach(row => {
      expect(row).toBeDefined()
      expect(
        reserveStatusIs(row, SystemContracts.SysioReservReservestatus.RESERVE_STATUS_ACTIVE)
      ).toBe(true)
      expect(row.owner).toBe(owner.account)
      expect(row.is_private === true || Number(row.is_private) === 1).toBe(true)
    })
    // The matches escrowed the requested WIRE verbatim.
    expect(BigInt(ethRow.reserve_wire_amount)).toBe(CreateParams.EthereumRequestedWire)
    expect(BigInt(solRow.reserve_wire_amount)).toBe(CreateParams.SolanaRequestedWire)
    // The chain sides seeded at the DEPOT-FRAME conversion of each escrow
    // (`ReserveCreate.external_amount` — toDepot(wei,18) / to_depot(·,6)),
    // not the raw chain-native units.
    expect(BigInt(ethRow.reserve_chain_amount)).toBe(CreateParams.EthereumEscrowDepotUnits)
    expect(BigInt(solRow.reserve_chain_amount)).toBe(CreateParams.SolanaEscrowDepotUnits)
  })

  // ── Phase A: ETH (native) → USDCSOL (SPL) through the private pair ──────

  describe("Phase A: ETH (native) → USDCSOL (SPL)", () => {
    let ethRowBefore: { chain: bigint; wire: bigint }
    let solRowBefore: { chain: bigint; wire: bigint }
    let wireIntermediateA: bigint
    let targetA: bigint
    let userAtaBefore: bigint

    test("compute the private-pair quote (two-hop constant product)", async () => {
      // Mirror the depot's `swap_quote` / `applyswap` math exactly from
      // the live pre-swap rows: w = cp(src.chain, src.wire, amt) then
      // out = cp(dst.wire, dst.chain, w). Same integers in == same
      // integers out, so the variance check sees zero drift and the
      // books assertions below can demand exact equality.
      const ethRow = await ethPrivateRow()
      const solRow = await solPrivateRow()
      ethRowBefore = {
        chain: BigInt(ethRow.reserve_chain_amount),
        wire:  BigInt(ethRow.reserve_wire_amount)
      }
      solRowBefore = {
        chain: BigInt(solRow.reserve_chain_amount),
        wire:  BigInt(solRow.reserve_wire_amount)
      }
      wireIntermediateA = cpOutput(
        ethRowBefore.chain, ethRowBefore.wire, SwapAmounts.PhaseASourceDepotUnits
      )
      targetA = cpOutput(solRowBefore.wire, solRowBefore.chain, wireIntermediateA)
      expect(wireIntermediateA).toBeGreaterThan(0n)
      expect(targetA).toBeGreaterThan(0n)
      userAtaBefore = await getSplBalance(solanaConnection, userUsdcSolAta)
      log.info(`[PhaseA] w=${wireIntermediateA} target=${targetA} (depot units)`)
    })

    test("user calls ReserveManager.requestSwap sourcing the private ETH reserve", async () => {
      // The swap USER signs on-chain with the same wallet that created
      // the reserves — but ownership lives with the WIRE account
      // (privowner); the user is not the owner of anything here.
      const result = await requestEthereumSwap(reserveManager as any, {
        sourceTokenCode:    BigInt(Reserves.Ethereum.TokenCode),
        sourceReserveCode:  BigInt(Reserves.PrivateReserveCode),
        sourceAmountWei:    SwapAmounts.PhaseASourceWei,
        targetChainCode:    BigInt(Reserves.Solana.ChainCode),
        targetTokenCode:    BigInt(Reserves.Solana.TokenCode),
        targetReserveCode:  BigInt(Reserves.PrivateReserveCode),
        // SPL recipients ride as the WALLET pubkey — the outpost pays
        // the recipient's ATA (pre-existing here via the beforeAll mint).
        targetRecipient:    users.solanaPublicKeyBytes,
        targetAmount:       targetA,
        targetToleranceBps: Variance.ToleranceBps
      })
      expect(result.transactionHash).toBeTruthy()
    })

    test("depot creates the PENDING private-pair UWREQ", async () => {
      await pollUntil(
        "PhaseA private-pair UWREQ row appears",
        async () => (await uwreqMatching(
          Reserves.Ethereum.ChainCode,
          Reserves.PrivateReserveCode,
          Reserves.Solana.ChainCode
        )) !== undefined,
        Timing.UwreqDeadlineMs,
        Timing.LongPollIntervalMs
      )
      const row = await uwreqMatching(
        Reserves.Ethereum.ChainCode,
        Reserves.PrivateReserveCode,
        Reserves.Solana.ChainCode
      )
      // Same-owner pairing admitted: the privacy gate let the request
      // through to a real UWREQ instead of a SWAP_REVERT.
      expect(slugValue(row.dst_token_code)).toBe(Reserves.Solana.TokenCode)
      expect(BigInt(row.src_amount)).toBe(SwapAmounts.PhaseASourceDepotUnits)
    }, Timing.UwreqDeadlineMs + 30_000)

    test("UWREQ resolves CONFIRMED with TWO locks (one per leg)", async () => {
      await pollUntil(
        "PhaseA UWREQ status=CONFIRMED",
        async () => uwreqConfirmed(await uwreqMatching(
          Reserves.Ethereum.ChainCode,
          Reserves.PrivateReserveCode,
          Reserves.Solana.ChainCode
        )),
        Timing.RaceDeadlineMs,
        Timing.LongPollIntervalMs
      )
      const row = await uwreqMatching(
        Reserves.Ethereum.ChainCode,
        Reserves.PrivateReserveCode,
        Reserves.Solana.ChainCode
      )
      const locks = await locksForUwreq(Number(row.id))
      expect(locks).toHaveLength(2)
      const lockChains = locks.map(l => slugValue(l.chain_code)).sort((a, b) => a - b)
      const expectedChains = [Reserves.Ethereum.ChainCode, Reserves.Solana.ChainCode]
        .sort((a, b) => a - b)
      expect(lockChains).toEqual(expectedChains)
    }, Timing.RaceDeadlineMs + 30_000)

    test("emit-time four-leg books move on the two private rows", async () => {
      // `applyswap` fires inline with the race win: src.chain += src,
      // src.wire -= w (gross), dst.wire += net, dst.chain -= target. #414 skims
      // the WIRE-leg fee inside the hop, so the destination gains the post-fee
      // net and the pair's Σwire drops by exactly the fee (no longer conserved).
      const feeA = WIREClient.splitWireFee(wireIntermediateA)
      const ethRow = await ethPrivateRow()
      const solRow = await solPrivateRow()
      expect(BigInt(ethRow.reserve_chain_amount))
        .toBe(ethRowBefore.chain + SwapAmounts.PhaseASourceDepotUnits)
      expect(BigInt(ethRow.reserve_wire_amount))
        .toBe(ethRowBefore.wire - wireIntermediateA)
      expect(BigInt(solRow.reserve_wire_amount))
        .toBe(solRowBefore.wire + wireIntermediateA - feeA.fee)
      expect(BigInt(solRow.reserve_chain_amount))
        .toBe(solRowBefore.chain - targetA)
      // Σ reserve_wire_amount over the pair drops by the WIRE-leg fee.
      expect(
        BigInt(ethRow.reserve_wire_amount) + BigInt(solRow.reserve_wire_amount)
      ).toBe(ethRowBefore.wire + solRowBefore.wire - feeA.fee)
    })

    test("user's USDCSOL ATA bumps by ~target", async () => {
      // USDCSOL is carried at native 6-dec in the depot frame, so the target
      // is already in SPL base units — `from_depot(target, 6)` is the identity
      // (UsdcSolFromDepotDivisor = 1) and the user's ATA bumps by ~target.
      const drift = (targetA * BigInt(Variance.ToleranceBps)) / 10_000n
      const floor =
        userAtaBefore + (targetA - drift) / SwapAmounts.UsdcSolFromDepotDivisor
      await pollUntil(
        "PhaseA user USDCSOL ATA bump",
        async () => (await getSplBalance(solanaConnection, userUsdcSolAta)) >= floor,
        Timing.RemitDeadlineMs,
        Timing.LongPollIntervalMs
      )
      const final = await getSplBalance(solanaConnection, userUsdcSolAta)
      log.info(`[PhaseA] user received ${final - userAtaBefore} USDCSOL base units`)
      expect(final - userAtaBefore).toBeGreaterThan(0n)
    }, Timing.RemitDeadlineMs + 30_000)
  })

  // ── Phase B: USDCSOL (SPL) → ETH (native) through the private pair ──────

  describe("Phase B: USDCSOL (SPL) → ETH (native)", () => {
    let ethRowBefore: { chain: bigint; wire: bigint }
    let solRowBefore: { chain: bigint; wire: bigint }
    let wireIntermediateB: bigint
    let targetB: bigint
    let ethBalanceBefore: bigint

    test("compute the inverse private-pair quote", async () => {
      // Same two-hop math, inverted: the SOL reserve is the source leg.
      // Rows are read LIVE so Phase A's book movement is the new baseline.
      const ethRow = await ethPrivateRow()
      const solRow = await solPrivateRow()
      ethRowBefore = {
        chain: BigInt(ethRow.reserve_chain_amount),
        wire:  BigInt(ethRow.reserve_wire_amount)
      }
      solRowBefore = {
        chain: BigInt(solRow.reserve_chain_amount),
        wire:  BigInt(solRow.reserve_wire_amount)
      }
      wireIntermediateB = cpOutput(
        solRowBefore.chain, solRowBefore.wire, SwapAmounts.PhaseBSourceDepotUnits
      )
      targetB = cpOutput(ethRowBefore.wire, ethRowBefore.chain, wireIntermediateB)
      expect(wireIntermediateB).toBeGreaterThan(0n)
      expect(targetB).toBeGreaterThan(0n)
      ethBalanceBefore = await context.ethProvider.getBalance(users.ethereumWallet.address)
      log.info(`[PhaseB] w=${wireIntermediateB} target=${targetB} (depot units)`)
    })

    test("user calls opp_outpost::request_swap_spl sourcing the private USDCSOL reserve", async () => {
      const sig = await requestSolanaSwapSpl(
        solanaConnection,
        oppProgram,
        users.solanaKeypair,
        {
          sourceTokenCode:    BigInt(Reserves.Solana.TokenCode),
          sourceReserveCode:  BigInt(Reserves.PrivateReserveCode),
          sourceAmount:       SwapAmounts.PhaseBSourceSplUnits,
          sourceMint:         usdcSolMint,
          targetChainCode:    BigInt(Reserves.Ethereum.ChainCode),
          targetTokenCode:    BigInt(Reserves.Ethereum.TokenCode),
          targetReserveCode:  BigInt(Reserves.PrivateReserveCode),
          targetRecipient:    users.ethereumAddressBytes,
          targetAmount:       targetB,
          targetToleranceBps: Variance.ToleranceBps
        }
      )
      expect(sig).toBeTruthy()
    })

    test("depot creates the PENDING inverse UWREQ", async () => {
      await pollUntil(
        "PhaseB private-pair UWREQ row appears",
        async () => (await uwreqMatching(
          Reserves.Solana.ChainCode,
          Reserves.PrivateReserveCode,
          Reserves.Ethereum.ChainCode
        )) !== undefined,
        Timing.UwreqDeadlineMs,
        Timing.LongPollIntervalMs
      )
      const row = await uwreqMatching(
        Reserves.Solana.ChainCode,
        Reserves.PrivateReserveCode,
        Reserves.Ethereum.ChainCode
      )
      // `request_swap_spl` rescales the 6-dec source into the depot
      // frame before the attestation, so the UWREQ carries 1e8.
      expect(BigInt(row.src_amount)).toBe(SwapAmounts.PhaseBSourceDepotUnits)
    }, Timing.UwreqDeadlineMs + 30_000)

    test("UWREQ resolves CONFIRMED with TWO locks (one per leg)", async () => {
      await pollUntil(
        "PhaseB UWREQ status=CONFIRMED",
        async () => uwreqConfirmed(await uwreqMatching(
          Reserves.Solana.ChainCode,
          Reserves.PrivateReserveCode,
          Reserves.Ethereum.ChainCode
        )),
        Timing.RaceDeadlineMs,
        Timing.LongPollIntervalMs
      )
      const row = await uwreqMatching(
        Reserves.Solana.ChainCode,
        Reserves.PrivateReserveCode,
        Reserves.Ethereum.ChainCode
      )
      const locks = await locksForUwreq(Number(row.id))
      expect(locks).toHaveLength(2)
      const lockChains = locks.map(l => slugValue(l.chain_code)).sort((a, b) => a - b)
      const expectedChains = [Reserves.Ethereum.ChainCode, Reserves.Solana.ChainCode]
        .sort((a, b) => a - b)
      expect(lockChains).toEqual(expectedChains)
    }, Timing.RaceDeadlineMs + 30_000)

    test("emit-time four-leg books move on the two private rows (inverted)", async () => {
      // Inverted hop: SOL is the source (gives up gross wireIntermediateB),
      // ETH the destination (gains the post-fee net); Σwire drops by the fee.
      const feeB = WIREClient.splitWireFee(wireIntermediateB)
      const ethRow = await ethPrivateRow()
      const solRow = await solPrivateRow()
      expect(BigInt(solRow.reserve_chain_amount))
        .toBe(solRowBefore.chain + SwapAmounts.PhaseBSourceDepotUnits)
      expect(BigInt(solRow.reserve_wire_amount))
        .toBe(solRowBefore.wire - wireIntermediateB)
      expect(BigInt(ethRow.reserve_wire_amount))
        .toBe(ethRowBefore.wire + wireIntermediateB - feeB.fee)
      expect(BigInt(ethRow.reserve_chain_amount))
        .toBe(ethRowBefore.chain - targetB)
      expect(
        BigInt(ethRow.reserve_wire_amount) + BigInt(solRow.reserve_wire_amount)
      ).toBe(ethRowBefore.wire + solRowBefore.wire - feeB.fee)
    })

    test("user's ETH balance bumps by ~target", async () => {
      // target is depot 9-dec; native ETH is 18-dec so the ETH outpost
      // pays `target × 1e9` wei from its custody balance.
      const targetWei = targetB * SwapAmounts.EthWeiPerDepotUnit
      const driftWei  = (targetWei * BigInt(Variance.ToleranceBps)) / 10_000n
      const floor     = ethBalanceBefore + (targetWei - driftWei)
      await pollUntil(
        "PhaseB user receives ETH",
        async () =>
          (await context.ethProvider.getBalance(users.ethereumWallet.address)) >= floor,
        Timing.RemitDeadlineMs,
        Timing.LongPollIntervalMs
      )
      const final = await context.ethProvider.getBalance(users.ethereumWallet.address)
      log.info(`[PhaseB] user received ${final - ethBalanceBefore} wei (targetWei=${targetWei})`)
      expect(final - ethBalanceBefore).toBeGreaterThan(0n)
    }, Timing.RemitDeadlineMs + 30_000)
  })

  // ── WIRE-endpoint exclusion still binds for the owned private pair ──────

  test("private → WIRE is not allowed (SWAP_REVERT, no uwreq)", async () => {
    // The privacy gate's WIRE-endpoint branch fires before the variance
    // check ever sees the sentinel target — the request draws a
    // SWAP_REVERT and no (src=PRIVATE, dst=WIRE) UWREQ is created. The
    // Phase A uwreq (dst=SOLANA) is excluded by the dst filter.
    const result = await requestEthereumSwap(reserveManager as any, {
      sourceTokenCode:    BigInt(Reserves.Ethereum.TokenCode),
      sourceReserveCode:  BigInt(Reserves.PrivateReserveCode),
      sourceAmountWei:    WireProbe.SourceEthereumWei,
      targetChainCode:    BigInt(Reserves.Wire.ChainCode),
      targetTokenCode:    BigInt(Reserves.Wire.TokenCode),
      targetReserveCode:  BigInt(Reserves.Wire.SentinelReserveCode),
      targetRecipient:    new TextEncoder().encode(WireProbe.RecipientName),
      targetAmount:       WireProbe.TargetAmount,
      targetToleranceBps: WireProbe.ToleranceBps
    })
    expect(result.transactionHash).toBeTruthy()

    // Inverted poll: `pollUntil` throwing its deadline error IS the pass.
    await expect(
      pollUntil(
        "forbidden private→WIRE UWREQ",
        async () => (await uwreqMatching(
          Reserves.Ethereum.ChainCode,
          Reserves.PrivateReserveCode,
          Reserves.Wire.ChainCode
        )) !== undefined,
        Timing.NoUwreqWindowMs,
        Timing.LongPollIntervalMs
      )
    ).rejects.toThrow(/Timed out/)
  }, Timing.NoUwreqWindowMs + 60_000)
})

/**
 * Encode a slug_name `number` as an 8-byte little-endian Buffer matching
 * the program's `to_le_bytes()` PDA seed derivation.
 */
function slugNameToLeBuffer(value: number): Buffer {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64LE(BigInt(value))
  return buf
}

/**
 * Constant-product output mirroring `sysio.reserv::cp_output` exactly
 * (uint128-safe floor division). Returns `0n` when any side is zero so
 * mis-sized reserves surface as a failed `> 0n` expectation instead of a
 * divide-by-zero.
 */
function cpOutput(reserveSrc: bigint, reserveDst: bigint, srcAmount: bigint): bigint {
  if (reserveSrc <= 0n || reserveDst <= 0n || srcAmount <= 0n) return 0n
  return (reserveDst * srcAmount) / (reserveSrc + srcAmount)
}

/**
 * Current SPL balance of `ata` in base units — `0n` when the account
 * doesn't exist yet (the SOL outpost creates recipient ATAs on demand).
 */
async function getSplBalance(
  connection: Connection,
  ata:        PublicKey
): Promise<bigint> {
  try {
    const account = await getAccount(connection, ata)
    return account.amount
  } catch {
    return 0n
  }
}

/**
 * Sign + send a pre-built transaction and poll `getSignatureStatus`
 * until `confirmed`/`finalized` — the same WebSocket-free confirmation
 * loop the harness's Solana tools use (`solana-test-validator` doesn't
 * reliably serve a WS endpoint).
 */
async function sendAndConfirmSolanaTx(
  connection: Connection,
  tx:         anchor.web3.Transaction,
  signer:     Keypair,
  label:      string
): Promise<string> {
  const sig = await connection.sendTransaction(tx, [signer], { skipPreflight: false })
  const deadline = Date.now() + SOL_CONFIRM_TIMEOUT_MS
  while (Date.now() < deadline) {
    const status = await connection.getSignatureStatus(sig)
    const conf   = status?.value?.confirmationStatus
    if (conf === "confirmed" || conf === "finalized") return sig
    if (status?.value?.err) {
      throw new Error(`${label} tx failed: ${JSON.stringify(status.value.err)}`)
    }
    await new Promise(resolve => setTimeout(resolve, SOL_CONFIRM_POLL_MS))
  }
  throw new Error(`${label} tx ${sig} not confirmed within ${SOL_CONFIRM_TIMEOUT_MS}ms`)
}
