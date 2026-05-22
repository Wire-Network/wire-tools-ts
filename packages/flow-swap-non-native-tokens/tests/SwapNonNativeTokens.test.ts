import "jest"
import * as anchor from "@coral-xyz/anchor"
import { Connection, Keypair, PublicKey } from "@solana/web3.js"
import { TokenAmount } from "@wireio/opp-typescript-models"
import {
  getAssociatedTokenAddressSync,
  getAccount
} from "@solana/spl-token"
import { ethers } from "ethers"
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
  mintMockSplToUser,
  resolveLatestNonce
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
    // Underwriter must bond on every (chain, token) leg this flow's
    // swap matrix touches. The depot's `sysio.uwrit::createuwreq`
    // re-checks `meets_role_min` for BOTH legs of every swap; the
    // underwriter plugin's `select_coverable` further requires a
    // non-zero credit-line bucket per (chain, token_kind). Without
    // a USDC/USDT/LIQETH/USDCSOL/USDTSOL/LIQSOL deposit, the swap
    // gets reverted with "insufficient bond on one or both legs".
    //
    // Amounts are large enough to cover several round-trips of the
    // 0.1-unit-of-each swap tests (`SwapAmounts.SourceErc20Stable`
    // = 100_000 chain units; `TargetAmounts.Default` = 98_000_000
    // depot units).
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
        // ETH-side bonds — native + every ERC-20 the swap matrix
        // sources from or targets to.
        {
          chain_code: SlugName.from("ETHEREUM"),
          amount: TokenAmount.create({
            tokenCode: BigInt(SlugName.from("ETH")),
            amount:    uwCollatAmount
          })
        },
        {
          chain_code: SlugName.from("ETHEREUM"),
          amount: TokenAmount.create({
            tokenCode: BigInt(SlugName.from("USDC")),
            amount:    uwCollatAmount
          })
        },
        {
          chain_code: SlugName.from("ETHEREUM"),
          amount: TokenAmount.create({
            tokenCode: BigInt(SlugName.from("USDT")),
            amount:    uwCollatAmount
          })
        },
        // SOL-side bonds — native + every SPL the swap matrix uses.
        {
          chain_code: SlugName.from("SOLANA"),
          amount: TokenAmount.create({
            tokenCode: BigInt(SlugName.from("SOL")),
            amount:    uwCollatAmount
          })
        },
        {
          chain_code: SlugName.from("SOLANA"),
          amount: TokenAmount.create({
            tokenCode: BigInt(SlugName.from("USDCSOL")),
            amount:    uwCollatAmount
          })
        },
        {
          chain_code: SlugName.from("SOLANA"),
          amount: TokenAmount.create({
            tokenCode: BigInt(SlugName.from("USDTSOL")),
            amount:    uwCollatAmount
          })
        }
      ]]
    })
    users = await ensureSwapUserIdentities(context)

    // ── ETH-side: ReserveManager + mock ERC-20s ──
    const ethAddrs = context.loadETHAddresses()
    reserveManager = context.loadETHContract("ReserveManager", ethAddrs.ReserveManager)
      .connect(users.ethereumWallet) as ethers.Contract
    // Mock ERC-20s live under contracts/test/outpost/ (not the
    // production contracts/outpost/ that FlowTestContext.loadETHABI
    // assumes); load their ABIs directly from the hardhat artifacts.
    // Bind to the *deployer* signer (anvil HD 0) for the funding-time
    // `mint(...)` calls — the user wallet (HD index 32) has surfaced
    // intermittent "nonce too low" rejections from anvil despite a
    // freshly-spawned validator, and the mocks expose `mint(...)`
    // ungated so any signer suffices. The downstream permit / approval
    // tests pass `users.ethereumWallet` explicitly to `signErc20Permit`
    // / `ReserveManager.connect(users.ethereumWallet)` so they still
    // exercise the user-signed source-custody path.
    mockUsdc = new ethers.Contract(
      ethAddrs.MockUsdc, loadTestERC20Abi(context.ethereumPath!, "MockUsdc"),
      context.ethSigner
    )
    mockUsdt = new ethers.Contract(
      ethAddrs.MockUsdt, loadTestERC20Abi(context.ethereumPath!, "MockUsdt"),
      context.ethSigner
    )

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
    const usdcEntry   = splMints.find(m => m.code === SlugName.from("USDCSOL"))
    const usdtEntry   = splMints.find(m => m.code === SlugName.from("USDTSOL"))
    if (!usdcEntry || !usdtEntry) {
      throw new Error("Bootstrap did not persist USDCSOL/USDTSOL SPL mints")
    }
    mockUsdcSolMint = new PublicKey(usdcEntry.mint)
    mockUsdtSolMint = new PublicKey(usdtEntry.mint)

    // Load the cluster deployer keypair (mint authority on the
    // mock SPL mints created by `SOLBootstrap.provisionSplReserves`).
    // `SOLBootstrap.bootstrap` persists the deployer keypair to
    // `<cluster>/data/sol-deployer-keypair.json` whether it loaded
    // it from `~/.config/solana/id.json` or generated a fresh one.
    const deployerKeypairPath = Path.join(
      context.clusterPath, "data", "sol-deployer-keypair.json"
    )
    solDeployer = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(Fs.readFileSync(deployerKeypairPath, "utf-8")))
    )

    // Fund the user with mock balances on both chains so they can
    // source-spend in each test cell. MockUsdc/Usdt mint is ungated
    // (test-cluster convenience) so the deployer-signed mint above is
    // sufficient. Use stderr.write for the diagnostic — Console.info
    // can race with jest's stdout capture on a failing beforeAll.
    const userAddr = users.ethereumWallet.address
    process.stderr.write(`[flow-snnt] funding user ${userAddr}\n`)
    const fundAmtErc20 = 100n * SwapAmounts.SourceErc20Stable // 10 USDC / 10 USDT on ETH
    await mintMockErc20ToUser(mockUsdc as any, userAddr, fundAmtErc20)
    process.stderr.write(`[flow-snnt] usdc mint complete\n`)
    await mintMockErc20ToUser(mockUsdt as any, userAddr, fundAmtErc20)
    process.stderr.write(`[flow-snnt] usdt mint complete\n`)
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
    // `WIREClient.getTableRows` unwraps v6's `{key, value}` KV-row
    // envelope automatically — slug-name fields appear flattened on
    // each row as `chain_code: {value}`, `token_code: {value}`.
    const slugValue = (v: unknown): number =>
      typeof v === "object" && v !== null && "value" in v
        ? Number((v as { value: unknown }).value)
        : Number(v)
    const ethCodes = rows
      .filter(r => slugValue(r.chain_code) === Reserves.Ethereum.ChainCode)
      .map(r => slugValue(r.token_code))
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
    const slugValue = (v: unknown): number =>
      typeof v === "object" && v !== null && "value" in v
        ? Number((v as { value: unknown }).value)
        : Number(v)
    const solCodes = rows
      .filter(r => slugValue(r.chain_code) === Reserves.Solana.ChainCode)
      .map(r => slugValue(r.token_code))
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

    // Pre-set allowance — `mockUsdt` is deployer-bound for the funding
    // step, so the test connects to the user signer inline so the
    // allowance is recorded against the user's balance (not the
    // deployer's). Mainnet USDT does not implement EIP-2612, so the
    // approval-path is the production codepath for those tokens.
    const userMockUsdt = mockUsdt.connect(users.ethereumWallet) as ethers.Contract
    const approveNonce = await resolveLatestNonce(userMockUsdt as ethers.BaseContract)
    const approveTx    = await userMockUsdt.approve(
      reserveManagerAddr,
      SwapAmounts.SourceErc20Stable,
      { nonce: approveNonce }
    )
    await approveTx.wait(1)

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
 * Load a test-only ERC-20 mock ABI from hardhat artifacts. Mock
 * contracts live under `contracts/test/outpost/` (separate from
 * production `contracts/outpost/` that `FlowTestContext.loadETHABI`
 * assumes).
 */
function loadTestERC20Abi(ethereumPath: string, contractName: string): ethers.InterfaceAbi {
  const artifactPath = Path.join(
    ethereumPath, "artifacts", "contracts", "test", "outpost",
    `${contractName}.sol`, `${contractName}.json`
  )
  return JSON.parse(Fs.readFileSync(artifactPath, "utf-8")).abi
}

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
