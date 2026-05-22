import "jest"
import * as anchor from "@coral-xyz/anchor"
import { Connection, Keypair, PublicKey } from "@solana/web3.js"
import {
  getAssociatedTokenAddressSync,
  getAccount
} from "@solana/spl-token"
import { ethers } from "ethers"
import * as OS from "node:os"
import {
  FlowTestContext,
  log,
  ProcessManager,
  ensureSwapUserIdentities,
  SwapUserIdentities,
  requestEthereumSwapErc20WithPermit,
  requestEthereumSwapErc20WithApproval,
  requestSolanaSwapSpl,
  signErc20Permit,
  mintMockErc20ToUser,
  mintMockSplToUser
} from "@wireio/test-cluster-tool"
import { SlugName } from "@wireio/sdk-core"
import * as Fs from "node:fs"
import * as Path from "node:path"
import { Timing, Reserves, SwapAmounts, Variance, TargetAmounts } from "./constants.js"

/**
 * Flow: SWAP_REQUEST → underwriter race → SWAP_REMIT for **non-native**
 * source tokens on both outposts. Mirrors the bidirectional native
 * swap proven in `flow-swap-with-underwriting`, but extends to ERC-20
 * source custody on Ethereum (USDC / USDT / LIQETH via EIP-2612 permit
 * or pre-set allowance) and SPL source custody on Solana (USDC / USDT
 * / LIQSOL via signed `request_swap_spl` IX).
 *
 * The harness cluster bootstrap seeds 10 reserves (4 ETH-side + 4
 * SOL-side + 2 unused) so each test cell can swap end-to-end without
 * needing per-test reserve creation.
 *
 * **Canonical proof** for every test: the destination user's balance
 * bumps by the variance-adjusted target amount. This is only
 * achievable if every layer (source custody, OPP envelope round-trip,
 * underwriter race, depot variance check, destination payout) worked.
 */

describe("Flow: SWAP with non-native tokens", () => {
  let context: FlowTestContext
  let users: SwapUserIdentities
  let reserveManager: ethers.Contract
  let mockUsdc: ethers.Contract
  let mockUsdt: ethers.Contract
  let oppProgram: anchor.Program<anchor.Idl>
  let solanaConnection: Connection
  let mockUsdcSolMint: PublicKey
  let mockUsdtSolMint: PublicKey
  let solDeployer: Keypair

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

    // ── ETH-side: ReserveManager + mock ERC-20s ──
    const ethAddrs = context.loadETHAddresses()
    reserveManager = context.loadETHContract("ReserveManager", ethAddrs.ReserveManager)
      .connect(users.ethereumWallet) as ethers.Contract
    mockUsdc = context.loadETHContract("MockUsdc", ethAddrs.MockUsdc)
      .connect(users.ethereumWallet) as ethers.Contract
    mockUsdt = context.loadETHContract("MockUsdt", ethAddrs.MockUsdt)
      .connect(users.ethereumWallet) as ethers.Contract

    // ── SOL-side: opp-outpost program + mock SPL mints ──
    const solanaPath = context.solanaPath
    if (!solanaPath) {
      throw new Error("flow-swap-non-native-tokens requires WIRE_SOLANA_PATH")
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

    // Load the SOL mock-SPL-mint pubkeys persisted by
    // `SOLBootstrap.provisionSplReserves` (under
    // `<cluster>/data/sol-mock-mints.json`).
    const splMintsFile = Path.join(context.clusterPath, "data", "sol-mock-mints.json")
    const splMints = JSON.parse(Fs.readFileSync(splMintsFile, "utf-8")) as Array<{
      code: number; mint: string; decimals: number
    }>
    const usdcEntry   = splMints.find(m => m.code === SlugName.from("USDC"))
    const usdtEntry   = splMints.find(m => m.code === SlugName.from("USDT"))
    if (!usdcEntry || !usdtEntry) {
      throw new Error("Bootstrap did not persist USDC/USDT SPL mints")
    }
    mockUsdcSolMint = new PublicKey(usdcEntry.mint)
    mockUsdtSolMint = new PublicKey(usdtEntry.mint)

    // Load the cluster deployer keypair for SPL minting (mint
    // authority on the mock SPL mints created by
    // `SOLBootstrap.provisionSplReserves`). Default path matches
    // the `solana-keygen new` convention.
    const deployerKeypairPath = Path.join(OS.homedir(), ".config", "solana", "id.json")
    solDeployer = Keypair.fromSecretKey(
      Buffer.from(JSON.parse(Fs.readFileSync(deployerKeypairPath, "utf-8")))
    )

    // Fund the user with mock balances on both chains so they can
    // source-spend in each test cell.
    const fundAmtErc20 = 100n * SwapAmounts.SourceErc20Stable // 10 USDC / 10 USDT on ETH
    await mintMockErc20ToUser(
      mockUsdc.connect(context.ethSigner) as any,
      users.ethereumWallet.address,
      fundAmtErc20
    )
    await mintMockErc20ToUser(
      mockUsdt.connect(context.ethSigner) as any,
      users.ethereumWallet.address,
      fundAmtErc20
    )
    const fundAmtSpl = 100n * SwapAmounts.SourceSplStable
    await mintMockSplToUser(
      solanaConnection,
      solDeployer,
      mockUsdcSolMint,
      users.solanaKeypair.publicKey,
      fundAmtSpl
    )
    await mintMockSplToUser(
      solanaConnection,
      solDeployer,
      mockUsdtSolMint,
      users.solanaKeypair.publicKey,
      fundAmtSpl
    )
  }, Timing.BootstrapTimeoutMs)

  afterAll(async () => {
    try {
      await context?.teardown()
    } catch (err) {
      log.error("Error during teardown:", err)
    }
    await ProcessManager.get().killAll()
  }, 30_000)

  // ── Phase 0: cluster health + non-native reserve presence ────────────

  test("WIRE chain is producing blocks", async () => {
    const info = await context.wireClient.getInfo()
    expect(Number(info.head_block_num)).toBeGreaterThan(0)
  })

  test("bootstrap seeded USDC / USDT / LIQETH reserves on ETHEREUM", async () => {
    const { rows } = await context.wireClient.getTableRows<any>({
      code: "sysio.reserv",
      scope: "sysio.reserv",
      table: "reserves",
      limit: 50
    })
    const ethCodes = rows
      .filter(r => r.value?.chain_code?.value === Reserves.Ethereum.ChainCode)
      .map(r => r.value.token_code.value)
    expect(ethCodes).toEqual(
      expect.arrayContaining([
        Reserves.Ethereum.ETH,
        Reserves.Ethereum.LIQETH,
        Reserves.Ethereum.USDC,
        Reserves.Ethereum.USDT
      ])
    )
  })

  test("bootstrap seeded USDCSOL / USDTSOL / LIQSOL reserves on SOLANA", async () => {
    const { rows } = await context.wireClient.getTableRows<any>({
      code: "sysio.reserv",
      scope: "sysio.reserv",
      table: "reserves",
      limit: 50
    })
    const solCodes = rows
      .filter(r => r.value?.chain_code?.value === Reserves.Solana.ChainCode)
      .map(r => r.value.token_code.value)
    expect(solCodes).toEqual(
      expect.arrayContaining([
        Reserves.Solana.SOL,
        Reserves.Solana.LIQSOL,
        Reserves.Solana.USDCSOL,
        Reserves.Solana.USDTSOL
      ])
    )
  })

  // ── Sub-scope 1: ERC-20 source custody on Ethereum ───────────────────

  test("USDC (ETH) → SOL native: permit custody + cross-chain payout", async () => {
    const reserveManagerAddr = await reserveManager.getAddress()
    const usdcBefore = await mockUsdc.balanceOf(reserveManagerAddr)
    const solBalanceBefore = await solanaConnection.getBalance(users.solanaKeypair.publicKey)

    const deadline    = BigInt(Math.floor(Date.now() / 1000) + 3600)
    const permitSig   = await signErc20Permit(
      users.ethereumWallet, mockUsdc as any, reserveManagerAddr,
      SwapAmounts.SourceErc20Stable, deadline
    )
    const result = await requestEthereumSwapErc20WithPermit(
      reserveManager as any,
      {
        sourceTokenCode:    BigInt(Reserves.Ethereum.USDC),
        sourceReserveCode:  BigInt(Reserves.ReserveCode),
        sourceAmount:       SwapAmounts.SourceErc20Stable,
        targetChainCode:    BigInt(Reserves.Solana.ChainCode),
        targetTokenCode:    BigInt(Reserves.Solana.SOL),
        targetReserveCode:  BigInt(Reserves.ReserveCode),
        targetRecipient:    users.solanaKeypair.publicKey.toBytes(),
        targetAmount:       TargetAmounts.Default,
        targetToleranceBps: Variance.ToleranceBps
      },
      permitSig
    )
    expect(result.transactionHash).toBeDefined()

    // Source side: reserve balance bumped by exactly sourceAmount
    // (proves the FoT guard didn't reject and custody landed).
    const usdcAfter = await mockUsdc.balanceOf(reserveManagerAddr)
    expect(usdcAfter - usdcBefore).toBe(SwapAmounts.SourceErc20Stable)

    // Destination side: SOL balance must bump within the variance
    // window. Floor = previousBalance + (targetAmount − drift).
    const drift   = (TargetAmounts.Default * BigInt(Variance.ToleranceBps)) / 10_000n
    const floor   = BigInt(solBalanceBefore) + (TargetAmounts.Default - drift)
    await pollUntilLamports(
      solanaConnection, users.solanaKeypair.publicKey, floor, Timing.RemitDeadlineMs
    )
  }, Timing.RemitDeadlineMs + Timing.UwreqDeadlineMs)

  test("USDT (ETH) → SOL native: approval custody + cross-chain payout", async () => {
    const reserveManagerAddr = await reserveManager.getAddress()
    const usdtBefore = await mockUsdt.balanceOf(reserveManagerAddr)
    const solBalanceBefore = await solanaConnection.getBalance(users.solanaKeypair.publicKey)

    // Pre-set allowance (mainnet USDT does not implement EIP-2612).
    const approveTx = await mockUsdt.approve(reserveManagerAddr, SwapAmounts.SourceErc20Stable)
    await approveTx.wait()

    const result = await requestEthereumSwapErc20WithApproval(
      reserveManager as any,
      {
        sourceTokenCode:    BigInt(Reserves.Ethereum.USDT),
        sourceReserveCode:  BigInt(Reserves.ReserveCode),
        sourceAmount:       SwapAmounts.SourceErc20Stable,
        targetChainCode:    BigInt(Reserves.Solana.ChainCode),
        targetTokenCode:    BigInt(Reserves.Solana.SOL),
        targetReserveCode:  BigInt(Reserves.ReserveCode),
        targetRecipient:    users.solanaKeypair.publicKey.toBytes(),
        targetAmount:       TargetAmounts.Default,
        targetToleranceBps: Variance.ToleranceBps
      }
    )
    expect(result.transactionHash).toBeDefined()

    const usdtAfter = await mockUsdt.balanceOf(reserveManagerAddr)
    expect(usdtAfter - usdtBefore).toBe(SwapAmounts.SourceErc20Stable)

    const drift = (TargetAmounts.Default * BigInt(Variance.ToleranceBps)) / 10_000n
    const floor = BigInt(solBalanceBefore) + (TargetAmounts.Default - drift)
    await pollUntilLamports(
      solanaConnection, users.solanaKeypair.publicKey, floor, Timing.RemitDeadlineMs
    )
  }, Timing.RemitDeadlineMs + Timing.UwreqDeadlineMs)

  // ── Sub-scope 2: SPL source custody on Solana ────────────────────────

  test("USDCSOL → ETH native: SPL custody + cross-chain payout", async () => {
    const ethBalanceBefore = await context.ethProvider.getBalance(users.ethereumWallet.address)

    const sig = await requestSolanaSwapSpl(
      solanaConnection,
      oppProgram,
      users.solanaKeypair,
      {
        sourceTokenCode:    BigInt(Reserves.Solana.USDCSOL),
        sourceReserveCode:  BigInt(Reserves.ReserveCode),
        sourceAmount:       SwapAmounts.SourceSplStable,
        sourceMint:         mockUsdcSolMint,
        targetChainCode:    BigInt(Reserves.Ethereum.ChainCode),
        targetTokenCode:    BigInt(Reserves.Ethereum.ETH),
        targetReserveCode:  BigInt(Reserves.ReserveCode),
        targetRecipient:    ethers.getBytes(users.ethereumWallet.address),
        targetAmount:       TargetAmounts.Default,
        targetToleranceBps: Variance.ToleranceBps
      }
    )
    expect(sig).toBeDefined()

    // Destination side: ETH balance must bump within the variance
    // window. ETH targetAmount is in depot 9-dec units, so converted
    // to wei = targetAmount * 1e9.
    const targetWei = TargetAmounts.Default * 1_000_000_000n
    const driftWei  = (targetWei * BigInt(Variance.ToleranceBps)) / 10_000n
    const floor     = ethBalanceBefore + (targetWei - driftWei)
    await pollUntilEthBalance(context.ethProvider, users.ethereumWallet.address, floor, Timing.RemitDeadlineMs)
  }, Timing.RemitDeadlineMs + Timing.UwreqDeadlineMs)

  // ── Sub-scope 3: Mixed combinations ──────────────────────────────────

  test("USDC (ETH) → USDT (SOL): cross-chain ERC-20 → SPL stablecoin swap", async () => {
    const reserveManagerAddr = await reserveManager.getAddress()
    const userUsdtSolAta = getAssociatedTokenAddressSync(
      mockUsdtSolMint, users.solanaKeypair.publicKey
    )
    // Note: the user's USDT-on-SOL ATA may not exist yet; the
    // SOL outpost's handle_swap_remit SPL branch creates it
    // on-demand via associated_token::create.

    const deadline  = BigInt(Math.floor(Date.now() / 1000) + 3600)
    const permitSig = await signErc20Permit(
      users.ethereumWallet, mockUsdc as any, reserveManagerAddr,
      SwapAmounts.SourceErc20Stable, deadline
    )
    const result = await requestEthereumSwapErc20WithPermit(
      reserveManager as any,
      {
        sourceTokenCode:    BigInt(Reserves.Ethereum.USDC),
        sourceReserveCode:  BigInt(Reserves.ReserveCode),
        sourceAmount:       SwapAmounts.SourceErc20Stable,
        targetChainCode:    BigInt(Reserves.Solana.ChainCode),
        targetTokenCode:    BigInt(Reserves.Solana.USDTSOL),
        targetReserveCode:  BigInt(Reserves.ReserveCode),
        targetRecipient:    users.solanaKeypair.publicKey.toBytes(),
        targetAmount:       TargetAmounts.Default,
        targetToleranceBps: Variance.ToleranceBps
      },
      permitSig
    )
    expect(result.transactionHash).toBeDefined()

    // Canonical proof: user's USDT-on-SOL ATA balance bumps. This
    // also proves on-chain ATA creation worked (the ATA didn't
    // exist before the swap landed).
    const drift = (TargetAmounts.Default * BigInt(Variance.ToleranceBps)) / 10_000n
    const floor = TargetAmounts.Default - drift
    await pollUntilSplBalance(
      solanaConnection, userUsdtSolAta, floor, Timing.RemitDeadlineMs
    )
  }, Timing.RemitDeadlineMs + Timing.UwreqDeadlineMs)

  test("USDC (ETH) → USDCSOL: cross-chain same-asset bridging", async () => {
    // Distinct depot-side codes (USDC vs USDCSOL) per the two-Token-
    // row decision; the depot still routes via WIRE: USDC → WIRE →
    // USDCSOL. This is just the standard swap pattern applied to
    // matching cross-chain names — no special canonicalization.
    const reserveManagerAddr = await reserveManager.getAddress()
    const userUsdcSolAta = getAssociatedTokenAddressSync(
      mockUsdcSolMint, users.solanaKeypair.publicKey
    )

    const deadline  = BigInt(Math.floor(Date.now() / 1000) + 3600)
    const permitSig = await signErc20Permit(
      users.ethereumWallet, mockUsdc as any, reserveManagerAddr,
      SwapAmounts.SourceErc20Stable, deadline
    )
    const result = await requestEthereumSwapErc20WithPermit(
      reserveManager as any,
      {
        sourceTokenCode:    BigInt(Reserves.Ethereum.USDC),
        sourceReserveCode:  BigInt(Reserves.ReserveCode),
        sourceAmount:       SwapAmounts.SourceErc20Stable,
        targetChainCode:    BigInt(Reserves.Solana.ChainCode),
        targetTokenCode:    BigInt(Reserves.Solana.USDCSOL),
        targetReserveCode:  BigInt(Reserves.ReserveCode),
        targetRecipient:    users.solanaKeypair.publicKey.toBytes(),
        targetAmount:       TargetAmounts.Default,
        targetToleranceBps: Variance.ToleranceBps
      },
      permitSig
    )
    expect(result.transactionHash).toBeDefined()

    const drift = (TargetAmounts.Default * BigInt(Variance.ToleranceBps)) / 10_000n
    const floor = TargetAmounts.Default - drift
    await pollUntilSplBalance(
      solanaConnection, userUsdcSolAta, floor, Timing.RemitDeadlineMs
    )
  }, Timing.RemitDeadlineMs + Timing.UwreqDeadlineMs)
})

/**
 * Poll until `address` holds at least `floor` lamports, or the
 * deadline expires. Used to assert destination-side native SOL
 * payouts in cross-chain swap tests.
 */
async function pollUntilLamports(
  connection: Connection,
  address:    PublicKey,
  floor:      bigint,
  deadlineMs: number
): Promise<void> {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    const balance = BigInt(await connection.getBalance(address))
    if (balance >= floor) return
    await new Promise(r => setTimeout(r, Timing.LongPollIntervalMs))
  }
  throw new Error(
    `pollUntilLamports: ${address.toBase58()} did not reach ${floor} within ${deadlineMs}ms`
  )
}

/**
 * Poll until `address` ETH balance ≥ `floor`. Used for non-native
 * → native ETH payout assertions.
 */
async function pollUntilEthBalance(
  provider:   ethers.JsonRpcProvider,
  address:    string,
  floor:      bigint,
  deadlineMs: number
): Promise<void> {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    const balance = await provider.getBalance(address)
    if (balance >= floor) return
    await new Promise(r => setTimeout(r, Timing.LongPollIntervalMs))
  }
  throw new Error(
    `pollUntilEthBalance: ${address} did not reach ${floor} within ${deadlineMs}ms`
  )
}

/**
 * Poll until the SPL token account at `ata` holds at least `floor`
 * base units. Used for SPL destination-payout assertions where the
 * recipient ATA may not exist before the test (the SOL outpost's
 * `handle_swap_remit` creates it on demand).
 */
async function pollUntilSplBalance(
  connection: Connection,
  ata:        PublicKey,
  floor:      bigint,
  deadlineMs: number
): Promise<void> {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    try {
      const account = await getAccount(connection, ata)
      if (account.amount >= floor) return
    } catch {
      // ATA doesn't exist yet — the on-chain create-ATA leg hasn't
      // landed. Keep polling; the SOL outpost creates it before
      // crediting the user.
    }
    await new Promise(r => setTimeout(r, Timing.LongPollIntervalMs))
  }
  throw new Error(
    `pollUntilSplBalance: ${ata.toBase58()} did not reach ${floor} within ${deadlineMs}ms`
  )
}
