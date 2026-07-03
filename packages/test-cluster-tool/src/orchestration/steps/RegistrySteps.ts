import Fs from "node:fs"
import Path from "node:path"
import Bluebird from "bluebird"
import { PublicKey as SolanaPublicKey } from "@solana/web3.js"
import { SlugName, SysioContracts } from "@wireio/sdk-core"
import { AnvilProcess } from "../../cluster/processes/AnvilProcess.js"
import { Report } from "../../report/Report.js"
import { ClusterBuildContext } from "../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../ClusterBuildStep.js"

const {
  SysioContractName,
  SysioChainsChainkind,
  SysioTokensTokenkind,
  SysioTokensChainkind
} = SysioContracts

/**
 * Seeds the depot registry (`sysio.chains` chains, `sysio.tokens` tokens +
 * chain-token bindings, `sysio.reserv` reserves). This is ONE composed step
 * because most rows are runtime-artifact-dependent — the ERC-20 / SPL / LIQ
 * addresses come from the outpost deploy artifacts (`outpost-addrs.json`,
 * `liqeth-addrs.json`, `sol-mock-mints.json`) that only exist after the outpost
 * deploy runs, so the rows cannot be static per-entry steps.
 */
export namespace RegistrySteps {
  /** Bootstrap reserve chain/wire seed amount (each token's depot frame = `min(native, 9)` decimals). */
  const ReserveSeedAmount = 10_000_000_000
  /** Bancor connector weight (bps) for every bootstrap reserve. */
  const ConnectorWeightBps = 5000
  /** Codenames whose reserves carry native 6-dec precision (stablecoins). */
  const StableCodenames = ["USDC", "USDT", "USDCSOL", "USDTSOL"]

  /** Seed chains + tokens + chain-token bindings + reserves. */
  export function seedRegistry<C extends ClusterBuildContext = ClusterBuildContext>(
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

  /** Named runner — port of the old `ClusterManager` Phase 16 / 16a / 16b / 16c. */
  export async function runSeedRegistry<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const chains = ctx.wire.getSysioContract(SysioContractName.chains),
      tokens = ctx.wire.getSysioContract(SysioContractName.tokens),
      reserv = ctx.wire.getSysioContract(SysioContractName.reserv),
      ethereumAddresses = readJson(
        Path.join(ctx.config.ethereumDeploymentsPath, "outpost-addrs.json")
      ),
      liqEthAddresses = readJson(
        Path.join(ctx.config.ethereumDeploymentsPath, "liqeth-addrs.json")
      ),
      solanaMints = readSolanaMints(Path.join(ctx.config.dataPath, "sol-mock-mints.json")),
      strip0x = (hex: string): string => hex.replace(/^0x/i, ""),
      emptyAddress = { kind: SysioTokensChainkind.CHAIN_KIND_UNKNOWN, address: "" },
      evmAddress = (hex: string | null) =>
        hex != null ? { kind: SysioTokensChainkind.CHAIN_KIND_EVM, address: strip0x(hex) } : emptyAddress,
      svmAddress = (mintBase58: string | null) =>
        mintBase58 != null
          ? {
              kind: SysioTokensChainkind.CHAIN_KIND_SVM,
              address: Buffer.from(new SolanaPublicKey(mintBase58).toBytes()).toString("hex")
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
        external_chain_id: AnvilProcess.DefaultChainId,
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
    await Bluebird.each(chainRegistrations, data => chains.actions.regchain.invoke(data))

    // ── tokens ──
    const tokenRegistrations: SysioContracts.SysioTokensRegtokenAction[] = [
      nativeToken("WIRE", "Wire", "WIRE chain native asset"),
      nativeToken("ETH", "Ether", "Ethereum native asset"),
      liqToken("LIQETH", "Liquid ETH", "Liquid-staking receipt for ETH", evmAddress(liqEthAddresses.LiqEthToken)),
      erc20Token("USDC", "USD Coin", "USDC stablecoin on Ethereum", evmAddress(ethereumAddresses.MockUsdc)),
      erc20Token("USDT", "Tether USD", "USDT stablecoin on Ethereum", evmAddress(ethereumAddresses.MockUsdt)),
      nativeToken("SOL", "Sol", "Solana native asset"),
      liqToken("LIQSOL", "Liquid SOL", "Liquid-staking receipt for SOL", svmAddress(solanaMints.LIQSOL)),
      splToken("USDCSOL", "USDC (Solana)", "USDC stablecoin on Solana", svmAddress(solanaMints.USDC)),
      splToken("USDTSOL", "USDT (Solana)", "USDT stablecoin on Solana", svmAddress(solanaMints.USDT))
    ]
    await Bluebird.each(tokenRegistrations, data => tokens.actions.regtoken.invoke(data))

    // ── chain-token bindings ──
    const chainTokenBindings: SysioContracts.SysioTokensRegctokAction[] = [
      chainToken("WIRE", "WIRE", "", true),
      chainToken("ETHEREUM", "ETH", "", true),
      chainToken("ETHEREUM", "LIQETH", nullableStrip(liqEthAddresses.LiqEthToken, strip0x), false),
      chainToken("ETHEREUM", "USDC", nullableStrip(ethereumAddresses.MockUsdc, strip0x), false),
      chainToken("ETHEREUM", "USDT", nullableStrip(ethereumAddresses.MockUsdt, strip0x), false),
      chainToken("SOLANA", "SOL", "", true),
      chainToken("SOLANA", "LIQSOL", nullableMintHex(solanaMints.LIQSOL), false),
      chainToken("SOLANA", "USDCSOL", nullableMintHex(solanaMints.USDC), false),
      chainToken("SOLANA", "USDTSOL", nullableMintHex(solanaMints.USDT), false)
    ]
    await Bluebird.each(chainTokenBindings, data => tokens.actions.regctok.invoke(data))

    // ── reserves (all static; stablecoins carry 6-dec precision + ÷1000 chain seed) ──
    const reservePairs: Array<[string, string, string]> = [
      ["ETHEREUM", "ETH", "native ETH"],
      ["ETHEREUM", "LIQETH", "liqETH"],
      ["ETHEREUM", "USDC", "USDC (mock ERC-20)"],
      ["ETHEREUM", "USDT", "USDT (mock ERC-20)"],
      ["SOLANA", "SOL", "native SOL"],
      ["SOLANA", "LIQSOL", "liqSOL"],
      ["SOLANA", "USDCSOL", "USDC (mock SPL)"],
      ["SOLANA", "USDTSOL", "USDT (mock SPL)"]
    ]
    await Bluebird.each(reservePairs, ([chainCodename, tokenCodename, label]) => {
      const stable = StableCodenames.includes(tokenCodename)
      return reserv.actions.regreserve.invoke({
        chain_code: { value: SlugName.from(chainCodename) },
        token_code: { value: SlugName.from(tokenCodename) },
        reserve_code: { value: SlugName.from("PRIMARY") },
        name: `${chainCodename}-${tokenCodename}/WIRE primary reserve`,
        description: `Bootstrap-seeded ${label} ↔ WIRE reserve`,
        initial_chain_amount: stable ? ReserveSeedAmount / 1000 : ReserveSeedAmount,
        initial_wire_amount: ReserveSeedAmount,
        source_token_precision: stable ? 6 : 9,
        connector_weight_bps: ConnectorWeightBps,
        is_private: false,
        owner: ""
      })
    })
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
  function nullableStrip(hex: string | null, strip: (h: string) => string): string {
    return hex != null ? strip(hex) : ""
  }

  /** Base58 mint → chain-native hex, else `""`. */
  function nullableMintHex(mintBase58: string | null): string {
    return mintBase58 != null
      ? Buffer.from(new SolanaPublicKey(mintBase58).toBytes()).toString("hex")
      : ""
  }
}
