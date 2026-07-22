import Fs from "node:fs"
import Path from "node:path"
import { PublicKey as SolanaPublicKey } from "@solana/web3.js"
import { SlugName, SysioContracts } from "@wireio/sdk-core"
import { eachSeries } from "../../utils/asyncUtils.js"
import { AnvilProcess } from "../../cluster/processes/AnvilProcess.js"
import { Report } from "../../report/Report.js"
import { ClusterBuildContext } from "../ClusterBuildContext.js"
import { ClusterBuildPhase } from "../ClusterBuildPhase.js"
import type { ClusterBuildParent } from "../ClusterBuildPhaseBase.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../ClusterBuildStep.js"
import { ClusterConfigProvider } from "../../config/ClusterConfigProvider.js"
import { ReservContractSteps } from "./contracts/sysio/ReservContractSteps.js"

const {
  SysioContractName,
  SysioChainsChainkind,
  SysioTokensTokenkind,
  SysioTokensChainkind
} = SysioContracts

/**
 * Seeds the depot registry (`sysio.chains` chains, `sysio.tokens` tokens +
 * chain-token bindings). This is ONE composed step because most rows are
 * runtime-artifact-dependent — the ERC-20 / SPL / LIQ addresses come from the
 * outpost deploy artifacts (`outpost-addrs.json`, `liqeth-addrs.json`,
 * `sol-mock-mints.json`) that only exist after the outpost deploy runs, so the
 * rows cannot be static per-entry steps.
 *
 * The mock (chain, token) PRIMARY reserves are seeded SEPARATELY, by the
 * {@link RegistrySteps.planMockReserves} phase — their rows ARE fully static, so
 * each is its own Report-validated `regreserve` step, gated behind
 * `--enable-mock-reserves` (default off; the contract gates `regreserve` to the
 * bootstrap epoch-0 window, so the phase only ever runs pre-EpochBootstrap).
 */
export namespace RegistrySteps {
  /** Bootstrap reserve chain/wire seed amount (each token's depot frame = `min(native, 9)` decimals). */
  const ReserveSeedAmount = 10_000_000_000
  /** Bancor connector weight (bps) for every bootstrap reserve. */
  const ConnectorWeightBps = 5000
  /** Codenames whose reserves carry native 6-dec precision (stablecoins). */
  const StableCodenames = ["USDC", "USDT", "USDCSOL", "USDTSOL"]
  /** Reserve code every mock reserve registers under. */
  const PrimaryReserveCodename = "PRIMARY"
  /** Divisor on a stablecoin reserve's chain seed (its 6-dec frame vs the 9-dec default). */
  const StableChainSeedDivisor = 1000
  /** `source_token_precision` for a stablecoin reserve (native 6-dec). */
  const StableTokenPrecision = 6
  /** `source_token_precision` for every non-stablecoin reserve (depot 9-dec frame). */
  const DefaultTokenPrecision = 9
  /**
   * The 8 mock (chain, token) reserve pairs — `[chainCodename, tokenCodename,
   * label]`. Private source both {@link MockReserveRegistrations} (the rows) and
   * {@link planMockReserves} (the per-step names) derive from, in this order.
   */
  const MockReservePairs = [
    ["ETHEREUM", "ETH", "native ETH"],
    ["ETHEREUM", "LIQETH", "liqETH"],
    ["ETHEREUM", "USDC", "USDC (mock ERC-20)"],
    ["ETHEREUM", "USDT", "USDT (mock ERC-20)"],
    ["SOLANA", "SOL", "native SOL"],
    ["SOLANA", "LIQSOL", "liqSOL"],
    ["SOLANA", "USDCSOL", "USDC (mock SPL)"],
    ["SOLANA", "USDTSOL", "USDT (mock SPL)"]
  ] as const

  /**
   * The 8 mock (chain, token) PRIMARY `sysio.reserv::regreserve` rows — fully
   * static (string codenames + numeric constants, no deploy-artifact reads),
   * byte-identical to the pre-split unconditional seeding. Shared by
   * {@link planMockReserves} (one Report step per row) and its unit test. The
   * contract gates `regreserve` to the bootstrap window (epoch 0), so these seed
   * ONLY during bootstrap — never from a flow phase.
   */
  export const MockReserveRegistrations: SysioContracts.SysioReservRegreserveAction[] =
    MockReservePairs.map(([chainCodename, tokenCodename, label]) =>
      toReserveRegistration(chainCodename, tokenCodename, label)
    )

  /** Seed chains + tokens + chain-token bindings. */
  export function planSeedRegistry<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, null> {
    return ClusterBuildStep.create<C, null>(
      actor,
      name,
      description,
      options,
      null,
      runSeedRegistry
    )
  }

  /**
   * Seed the 8 mock (chain, token) PRIMARY reserves as ONE
   * {@link ClusterBuildPhase} of per-reserve `sysio.reserv::regreserve` steps —
   * every reserve write is its own Report-validated step (the rows are fully
   * static, from {@link MockReserveRegistrations}). Composed ONLY when
   * `--enable-mock-reserves` is set; the depot contract gates `regreserve` to
   * the bootstrap window (epoch 0), so this phase only ever runs
   * pre-EpochBootstrap and can never be reached from a flow phase.
   * Self-registers on `parent`.
   *
   * @param parent - The build root or enclosing PhaseGroup.
   * @param name - Short phase name.
   * @param description - Human-readable phase description.
   * @param options - Step option overrides threaded to every reserve step.
   * @returns The self-registered reserve-seeding phase.
   */
  export function planMockReserves<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    parent: ClusterBuildParent<C>,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildPhase<C> {
    const steps: ClusterBuildStep.Any<C>[] = MockReservePairs.map(
      ([chainCodename, tokenCodename], index) =>
        ReservContractSteps.planRegreserve<C>(
          Report.Actor.Sysio,
          `seed-reserve-${chainCodename.toLowerCase()}-${tokenCodename.toLowerCase()}`,
          `seed the ${chainCodename}/${tokenCodename} PRIMARY reserve`,
          options,
          MockReserveRegistrations[index]
        )
    )
    return ClusterBuildPhase.create<C>(parent, name, description, steps)
  }

  /** Named runner — port of the old `ClusterManager` Phase 16 / 16a / 16b (chains, tokens, chain-token bindings). */
  export async function runSeedRegistry<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const chains = ctx.wire.getSysioContract(SysioContractName.chains),
      tokens = ctx.wire.getSysioContract(SysioContractName.tokens),
      ethereumAddresses = readJson(
        Path.join(
          ClusterConfigProvider.ethereumDeploymentsPath(ctx.config),
          "outpost-addrs.json"
        )
      ),
      liqEthAddresses = readJson(
        Path.join(
          ClusterConfigProvider.ethereumDeploymentsPath(ctx.config),
          "liqeth-addrs.json"
        )
      ),
      solanaMints = readSolanaMints(
        Path.join(ctx.config.dataPath, "sol-mock-mints.json")
      ),
      strip0x = (hex: string): string => hex.replace(/^0x/i, ""),
      emptyAddress = {
        kind: SysioTokensChainkind.CHAIN_KIND_UNKNOWN,
        address: ""
      },
      evmAddress = (hex: string | null) =>
        hex != null
          ? { kind: SysioTokensChainkind.CHAIN_KIND_EVM, address: strip0x(hex) }
          : emptyAddress,
      svmAddress = (mintBase58: string | null) =>
        mintBase58 != null
          ? {
              kind: SysioTokensChainkind.CHAIN_KIND_SVM,
              address: Buffer.from(
                new SolanaPublicKey(mintBase58).toBytes()
              ).toString("hex")
            }
          : emptyAddress

    // ── chains ──
    const chainRegistrations: SysioContracts.SysioChainsRegchainAction[] = [
      {
        kind: SysioChainsChainkind.CHAIN_KIND_WIRE,
        code: { value: SlugName.from("WIRE") },
        external_chain_id: 0,
        name: "Wire (depot)",
        description: "The WIRE depot chain itself"
      },
      {
        kind: SysioChainsChainkind.CHAIN_KIND_EVM,
        code: { value: SlugName.from("ETHEREUM") },
        // External-outpost mode registers the REAL remote chain id so the
        // depot's chains row matches what the daemons dial (networkFromConfig).
        external_chain_id:
          ctx.config.externalOutposts?.ethereum.chainId ??
          AnvilProcess.DefaultChainId,
        name: "Ethereum (anvil)",
        description: "Local anvil EVM chain (test cluster)"
      },
      {
        kind: SysioChainsChainkind.CHAIN_KIND_SVM,
        code: { value: SlugName.from("SOLANA") },
        external_chain_id: 0,
        name: "Solana (test-validator)",
        description: "Local solana-test-validator (test cluster)"
      }
    ]
    await eachSeries(chainRegistrations, data =>
      chains.actions.regchain.invoke(data)
    )

    // ── tokens ──
    const tokenRegistrations: SysioContracts.SysioTokensRegtokenAction[] = [
      nativeToken("WIRE", "Wire", "WIRE chain native asset"),
      nativeToken("ETH", "Ether", "Ethereum native asset"),
      liqToken(
        "LIQETH",
        "Liquid ETH",
        "Liquid-staking receipt for ETH",
        evmAddress(liqEthAddresses.LiqEthToken)
      ),
      erc20Token(
        "USDC",
        "USD Coin",
        "USDC stablecoin on Ethereum",
        evmAddress(ethereumAddresses.MockUsdc)
      ),
      erc20Token(
        "USDT",
        "Tether USD",
        "USDT stablecoin on Ethereum",
        evmAddress(ethereumAddresses.MockUsdt)
      ),
      nativeToken("SOL", "Sol", "Solana native asset"),
      liqToken(
        "LIQSOL",
        "Liquid SOL",
        "Liquid-staking receipt for SOL",
        svmAddress(solanaMints.LIQSOL)
      ),
      splToken(
        "USDCSOL",
        "USDC (Solana)",
        "USDC stablecoin on Solana",
        svmAddress(solanaMints.USDC)
      ),
      splToken(
        "USDTSOL",
        "USDT (Solana)",
        "USDT stablecoin on Solana",
        svmAddress(solanaMints.USDT)
      )
    ]
    await eachSeries(tokenRegistrations, data =>
      tokens.actions.regtoken.invoke(data)
    )

    // ── chain-token bindings ──
    const chainTokenBindings: SysioContracts.SysioTokensRegctokAction[] = [
      chainToken("WIRE", "WIRE", "", true),
      chainToken("ETHEREUM", "ETH", "", true),
      chainToken(
        "ETHEREUM",
        "LIQETH",
        nullableStrip(liqEthAddresses.LiqEthToken, strip0x),
        false
      ),
      chainToken(
        "ETHEREUM",
        "USDC",
        nullableStrip(ethereumAddresses.MockUsdc, strip0x),
        false
      ),
      chainToken(
        "ETHEREUM",
        "USDT",
        nullableStrip(ethereumAddresses.MockUsdt, strip0x),
        false
      ),
      chainToken("SOLANA", "SOL", "", true),
      chainToken(
        "SOLANA",
        "LIQSOL",
        nullableMintHex(solanaMints.LIQSOL),
        false
      ),
      chainToken("SOLANA", "USDCSOL", nullableMintHex(solanaMints.USDC), false),
      chainToken("SOLANA", "USDTSOL", nullableMintHex(solanaMints.USDT), false)
    ]
    await eachSeries(chainTokenBindings, data =>
      tokens.actions.regctok.invoke(data)
    )
  }

  // ── reserve-row builder (fully static — no deploy artifacts) ──

  /**
   * Build one static `regreserve` row for a (chain, token) PRIMARY reserve:
   * stablecoins carry native 6-dec precision + a ÷1000 chain seed, everything
   * else the depot's 9-dec frame. Byte-identical to the pre-split seeding.
   */
  function toReserveRegistration(
    chainCodename: string,
    tokenCodename: string,
    label: string
  ): SysioContracts.SysioReservRegreserveAction {
    const stable = StableCodenames.includes(tokenCodename)
    return {
      chain_code: { value: SlugName.from(chainCodename) },
      token_code: { value: SlugName.from(tokenCodename) },
      reserve_code: { value: SlugName.from(PrimaryReserveCodename) },
      name: `${chainCodename}-${tokenCodename}/WIRE primary reserve`,
      description: `Bootstrap-seeded ${label} ↔ WIRE reserve`,
      initial_chain_amount: stable
        ? ReserveSeedAmount / StableChainSeedDivisor
        : ReserveSeedAmount,
      initial_wire_amount: ReserveSeedAmount,
      source_token_precision: stable
        ? StableTokenPrecision
        : DefaultTokenPrecision,
      connector_weight_bps: ConnectorWeightBps,
      is_private: false,
      owner: ""
    }
  }

  // ── token-row builders (native = empty addr; the rest carry a ChainAddress) ──

  function nativeToken(
    codename: string,
    symbolName: string,
    description: string
  ): SysioContracts.SysioTokensRegtokenAction {
    return {
      kind: SysioTokensTokenkind.TOKEN_KIND_NATIVE,
      code: { value: SlugName.from(codename) },
      symbol_name: symbolName,
      description,
      precision: 9,
      address: { kind: SysioTokensChainkind.CHAIN_KIND_UNKNOWN, address: "" }
    }
  }

  function liqToken(
    codename: string,
    symbolName: string,
    description: string,
    address: { kind: SysioContracts.SysioTokensChainkind; address: string }
  ): SysioContracts.SysioTokensRegtokenAction {
    return {
      kind: SysioTokensTokenkind.TOKEN_KIND_LIQ,
      code: { value: SlugName.from(codename) },
      symbol_name: symbolName,
      description,
      precision: 9,
      address
    }
  }

  function erc20Token(
    codename: string,
    symbolName: string,
    description: string,
    address: { kind: SysioContracts.SysioTokensChainkind; address: string }
  ): SysioContracts.SysioTokensRegtokenAction {
    return {
      kind: SysioTokensTokenkind.TOKEN_KIND_ERC20,
      code: { value: SlugName.from(codename) },
      symbol_name: symbolName,
      description,
      precision: 6,
      address
    }
  }

  function splToken(
    codename: string,
    symbolName: string,
    description: string,
    address: { kind: SysioContracts.SysioTokensChainkind; address: string }
  ): SysioContracts.SysioTokensRegtokenAction {
    return {
      kind: SysioTokensTokenkind.TOKEN_KIND_SPL,
      code: { value: SlugName.from(codename) },
      symbol_name: symbolName,
      description,
      precision: 6,
      address
    }
  }

  function chainToken(
    chainCodename: string,
    tokenCodename: string,
    contractAddress: string,
    isNative: boolean
  ): SysioContracts.SysioTokensRegctokAction {
    return {
      chain_code: { value: SlugName.from(chainCodename) },
      token_code: { value: SlugName.from(tokenCodename) },
      contract_addr: contractAddress,
      is_native: isNative
    }
  }

  /** Read a deploy-artifact JSON, or `{}` when the file is absent. */
  function readJson(file: string): Record<string, string> {
    return Fs.existsSync(file) ? JSON.parse(Fs.readFileSync(file, "utf-8")) : {}
  }

  /**
   * Read `sol-mock-mints.json` (array of `{code, mint, decimals}`) into a
   * codename → base58-mint map, reverse-mapping the persisted numeric slug code.
   */
  function readSolanaMints(file: string): Record<string, string> {
    if (!Fs.existsSync(file)) return {}
    const rows = JSON.parse(Fs.readFileSync(file, "utf-8")) as Array<{
      code: number
      mint: string
      decimals: number
    }>
    const out: Record<string, string> = {}
    rows.forEach(row => {
      ;["USDC", "USDT", "LIQSOL"].forEach(codename => {
        if (SlugName.from(codename) === row.code) out[codename] = row.mint
      })
    })
    return out
  }

  /** `strip0x(hex)` when present, else `""`. */
  function nullableStrip(
    hex: string | null,
    strip: (h: string) => string
  ): string {
    return hex != null ? strip(hex) : ""
  }

  /** Base58 mint → chain-native hex, else `""`. */
  function nullableMintHex(mintBase58: string | null): string {
    return mintBase58 != null
      ? Buffer.from(new SolanaPublicKey(mintBase58).toBytes()).toString("hex")
      : ""
  }
}
