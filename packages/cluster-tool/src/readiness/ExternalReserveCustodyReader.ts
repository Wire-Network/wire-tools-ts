import { BN, BorshAccountsCoder, type Program } from "@coral-xyz/anchor"
import { JsonRpcProvider } from "@ethersproject/providers"
import { PublicKey } from "@solana/web3.js"
import { ClusterReadinessEndpointKind } from "@wireio/cluster-tool-shared"
import { SysioContracts } from "@wireio/sdk-core"
import type { LiqsolCore } from "@wireio/sdk-outpost"
import { getLogger } from "@wireio/shared"
import { getAddress, ZeroAddress } from "ethers"
import { match, P } from "ts-pattern"

import { WireReserveTool } from "../tools/wire/WireReserveTool.js"
import type { ReadinessContext } from "./ReadinessContext.js"
import type { ReadinessExternalCustodyReserve } from "./ReadinessOutputs.js"
import { loadSdkOutpost } from "./SdkOutpostLoader.js"
import {
  readinessErrorMessage,
  readinessEnumMatches,
  readinessReserveLabel,
  readinessSlugValue
} from "./readinessUtils.js"

const log = getLogger(__filename),
  EthereumNativeDecimals = 18,
  EthereumDecimalsCallData = "0x313ce567",
  EthereumRpcMethod = { call: "eth_call" } as const,
  EthereumBlockTag = { latest: "latest" } as const,
  SolanaNativeDecimals = 9,
  SolanaRpcMethod = {
    getAccountInfo: "getAccountInfo",
    getTokenSupply: "getTokenSupply",
    getTokenAccountBalance: "getTokenAccountBalance"
  } as const,
  SolanaCommitment = { confirmed: "confirmed" } as const,
  SolanaEncoding = { base64: "base64" } as const,
  SolanaAccountName = {
    outpostConfig: "outpostConfig",
    reserve: "reserve"
  } as const,
  SolanaOutpostConfigSeed = Buffer.from("outpost_config"),
  SolanaReserveSeed = Buffer.from("reserve"),
  SolanaReserveVaultSeed = Buffer.from("reserve_vault"),
  Unsigned64ByteLength = 8

enum EthereumLocalReserveStatus {
  pending = 0,
  active = 1,
  cancelled = 2
}

/** Decoded JSON-RPC account metadata returned by Solana `getAccountInfo`. */
export interface SolanaRpcAccount {
  /** Base64 account data and its encoding name. */
  data: [string, string]
  /** Whether the account contains executable program data. */
  executable: boolean
  /** Account balance in lamports. */
  lamports: number
  /** Owning program public key. */
  owner: string
  /** Rent epoch reported by the node. */
  rentEpoch: number
  /** Account data length in bytes. */
  space: number
}

/** Solana JSON-RPC `getAccountInfo` result used by readiness probes. */
export interface SolanaAccountInfoResponse {
  /** Account metadata, or `null` when the address is not initialized. */
  value: SolanaRpcAccount | null
}

interface SolanaTokenBalanceValue {
  amount: string
  decimals: number
}

interface SolanaTokenBalanceResponse {
  value: SolanaTokenBalanceValue
}

type SolanaOutpostConfig = Awaited<
  ReturnType<Program<LiqsolCore>["account"]["outpostConfig"]["fetch"]>
>
type SolanaReserve = Awaited<
  ReturnType<Program<LiqsolCore>["account"]["reserve"]["fetch"]>
>

/** Live depot registry rows needed to verify every external reserve mirror. */
export interface ExternalReserveCustodyState {
  /** Active external chain definitions. */
  chains: SysioContracts.SysioChainsChainRowType[]
  /** Active per-chain token bindings. */
  chainTokens: SysioContracts.SysioTokensChainTokenRowType[]
  /** Canonical token definitions and depot precisions. */
  tokens: SysioContracts.SysioTokensTokenRowType[]
  /** Advertised public reserves to verify. */
  reserves: SysioContracts.SysioReservReserveRowType[]
}

/** Read-only external custody verification for Ethereum and Solana reserves. */
export namespace ExternalReserveCustodyReader {
  /**
   * Read every advertised reserve's outpost mapping, local record, precision,
   * and custody balance.
   *
   * @param context Connected readiness context.
   * @param state Live depot registry state.
   * @return Per-reserve custody evidence without mutating either chain.
   */
  export async function read(
    context: ReadinessContext,
    state: ExternalReserveCustodyState
  ): Promise<ReadinessExternalCustodyReserve[]> {
    const ethereumReserves = state.reserves.filter(reserve =>
        reserveHasChainKind(
          state,
          reserve,
          SysioContracts.SysioChainsChainkind.CHAIN_KIND_EVM,
          "CHAIN_KIND_EVM"
        )
      ),
      solanaReserves = state.reserves.filter(reserve =>
        reserveHasChainKind(
          state,
          reserve,
          SysioContracts.SysioChainsChainkind.CHAIN_KIND_SVM,
          "CHAIN_KIND_SVM"
        )
      ),
      unsupported = state.reserves.filter(
        reserve =>
          !ethereumReserves.includes(reserve) &&
          !solanaReserves.includes(reserve)
      ),
      [ethereum, solana] = await Promise.all([
        readEthereumReserves(context, state, ethereumReserves),
        readSolanaReserves(context, state, solanaReserves)
      ])

    return [
      ...ethereum,
      ...solana,
      ...unsupported.map(reserve =>
        failedProbe(reserve, ["unsupported external chain kind"])
      )
    ]
  }
}

async function readEthereumReserves(
  context: ReadinessContext,
  state: ExternalReserveCustodyState,
  reserves: SysioContracts.SysioReservReserveRowType[]
): Promise<ReadinessExternalCustodyReserve[]> {
  if (reserves.length === 0) return []
  const endpoint = context.endpoint(ClusterReadinessEndpointKind.ethereum),
    profile = context.config.outpostDeploymentProfile
  if (!endpoint || !profile) {
    return reserves.map(reserve =>
      failedProbe(reserve, [
        !endpoint
          ? "Ethereum endpoint is missing"
          : "outpost deployment profile is missing"
      ])
    )
  }

  try {
    const { EthereumContractName, ReserveManager__factory } = loadSdkOutpost(),
      provider = new JsonRpcProvider({
        url: endpoint.url,
        timeout: context.config.timeoutMs
      }),
      manager = ReserveManager__factory.connect(
        profile.ethereum.contracts[EthereumContractName.ReserveManager].address,
        provider
      ),
      [nativeTokenCode, trackedCount] = await Promise.all([
        manager.nativeTokenCode(),
        manager.trackedCodesCount()
      ]),
      trackedIndexes = Array.from(
        { length: trackedCount.toNumber() },
        (_, index) => index
      ),
      trackedPairs = await Promise.all(
        trackedIndexes.map(async index => {
          const [tokenCode, reserveCode] = await Promise.all([
            manager.trackedTokenCodes(index),
            manager.trackedReserveCodes(index)
          ])
          return `${tokenCode.toString()}/${reserveCode.toString()}`
        })
      )

    return await Promise.all(
      reserves.map(async reserve => {
        try {
          const chainToken = assertChainToken(state, reserve),
            token = assertToken(state, reserve),
            tokenCode = BigInt(chainToken.token_code.value),
            reserveCode = BigInt(reserve.reserve_code.value),
            expectedAddress = chainToken.is_native
              ? ZeroAddress
              : getAddressWithPrefix(chainToken.contract_addr),
            [mappedAddress, precision, localReserve, balance] =
              await Promise.all([
                manager.tokenAddressesByCode(tokenCode),
                manager.tokenPrecisionByCode(tokenCode),
                manager.getReserve(tokenCode, reserveCode),
                manager.balanceOf(tokenCode)
              ]),
            nativeDecimals = chainToken.is_native
              ? EthereumNativeDecimals
              : await readEthereumTokenDecimals(
                  context,
                  endpoint.url,
                  expectedAddress
                ),
            configurationIssues = [
              chainToken.is_native &&
              nativeTokenCode.toString() !== tokenCode.toString()
                ? `native token code is ${nativeTokenCode.toString()}, expected ${tokenCode.toString()}`
                : null,
              !chainToken.is_native &&
              getAddress(mappedAddress) !== expectedAddress
                ? `token mapping is ${mappedAddress}, expected ${expectedAddress}`
                : null,
              precision !== nativeDecimals
                ? `outpost precision is ${precision}, expected ${nativeDecimals}`
                : null,
              token.precision !== WireReserveTool.depotPrecision(nativeDecimals)
                ? `depot token precision is ${token.precision}, expected ${WireReserveTool.depotPrecision(nativeDecimals)}`
                : null,
              reserve.source_token_precision !==
              WireReserveTool.depotPrecision(nativeDecimals)
                ? `depot reserve precision is ${reserve.source_token_precision}, expected ${WireReserveTool.depotPrecision(nativeDecimals)}`
                : null,
              !trackedPairs.includes(`${tokenCode}/${reserveCode}`)
                ? "reserve is absent from the tracked balance-sheet pairs"
                : null,
              !localReserve.exists ? "local reserve record is missing" : null,
              localReserve.exists &&
              localReserve.status !== EthereumLocalReserveStatus.active
                ? `local reserve status is ${localReserve.status}, expected ACTIVE`
                : null,
              localReserve.exists &&
              (localReserve.tokenCode.toString() !== tokenCode.toString() ||
                localReserve.reserveCode.toString() !== reserveCode.toString())
                ? "local reserve identity does not match the depot row"
                : null
            ].filter((issue): issue is string => issue != null),
            fundingIssues = [
              balance.lte(0) ? "external custody balance is zero" : null,
              localReserve.externalTokenAmount.lte(0)
                ? "local reserve amount is zero"
                : null
            ].filter((issue): issue is string => issue != null)

          return probe(
            reserve,
            configurationIssues,
            fundingIssues,
            balance.toString()
          )
        } catch (error: unknown) {
          log.warn(
            `Ethereum reserve custody probe failed for ${readinessReserveLabel(reserve)}: ${readinessErrorMessage(error)}`
          )
          return failedProbe(reserve, [readinessErrorMessage(error)])
        }
      })
    )
  } catch (error: unknown) {
    log.warn(
      `Ethereum reserve custody discovery failed: ${readinessErrorMessage(error)}`
    )
    return reserves.map(reserve =>
      failedProbe(reserve, [readinessErrorMessage(error)])
    )
  }
}

async function readSolanaReserves(
  context: ReadinessContext,
  state: ExternalReserveCustodyState,
  reserves: SysioContracts.SysioReservReserveRowType[]
): Promise<ReadinessExternalCustodyReserve[]> {
  if (reserves.length === 0) return []
  const endpoint = context.endpoint(ClusterReadinessEndpointKind.solana),
    profile = context.config.outpostDeploymentProfile
  if (!endpoint || !profile) {
    return reserves.map(reserve =>
      failedProbe(reserve, [
        !endpoint
          ? "Solana endpoint is missing"
          : "outpost deployment profile is missing"
      ])
    )
  }

  const { liqsolCoreIdl, SolanaProgramName } = loadSdkOutpost(),
    programId = new PublicKey(
      profile.solana.programs[SolanaProgramName.liqsolCore].address
    ),
    coder = new BorshAccountsCoder(liqsolCoreIdl),
    configAddress = deriveAddress(programId, [SolanaOutpostConfigSeed])
  try {
    const configAccount = await readSolanaAccount(
        context,
        endpoint.url,
        configAddress
      ),
      config = decodeAccount<SolanaOutpostConfig>(
        coder,
        SolanaAccountName.outpostConfig,
        configAccount
      )

    return await Promise.all(
      reserves.map(async reserve => {
        try {
          const chainToken = assertChainToken(state, reserve),
            token = assertToken(state, reserve),
            tokenCode = BigInt(chainToken.token_code.value),
            reserveCode = BigInt(reserve.reserve_code.value),
            expectedMint = chainToken.is_native
              ? PublicKey.default
              : new PublicKey(solanaPublicKey(chainToken.contract_addr)),
            mappedMint = config.tokenAddressesByCode.find(
              entry => entry.tokenCode.toString() === tokenCode.toString()
            )?.mint,
            configuredPrecision = config.precisionByTokenCode.find(
              entry => entry.tokenCode.toString() === tokenCode.toString()
            )?.decimals,
            reserveAddress = deriveReserveAddress(
              programId,
              SolanaReserveSeed,
              tokenCode,
              reserveCode
            ),
            reserveAccount = await readSolanaAccount(
              context,
              endpoint.url,
              reserveAddress
            ),
            localReserve = decodeAccount<SolanaReserve>(
              coder,
              SolanaAccountName.reserve,
              reserveAccount
            ),
            nativeDecimals = chainToken.is_native
              ? SolanaNativeDecimals
              : (
                  await context.jsonRpc<SolanaTokenBalanceResponse>(
                    endpoint.url,
                    SolanaRpcMethod.getTokenSupply,
                    [
                      expectedMint.toBase58(),
                      { commitment: SolanaCommitment.confirmed }
                    ]
                  )
                ).value.decimals,
            balance = chainToken.is_native
              ? BigInt(reserveAccount.lamports)
              : await readSolanaVaultBalance(
                  context,
                  endpoint.url,
                  deriveReserveAddress(
                    programId,
                    SolanaReserveVaultSeed,
                    tokenCode,
                    reserveCode
                  )
                ),
            configurationIssues = [
              config.chainCode.toString() !==
              String(readinessSlugValue(reserve.chain_code))
                ? `outpost chain code is ${config.chainCode.toString()}, expected ${readinessSlugValue(reserve.chain_code)}`
                : null,
              !mappedMint
                ? "token mapping is missing"
                : !mappedMint.equals(expectedMint)
                  ? `token mapping is ${mappedMint.toBase58()}, expected ${expectedMint.toBase58()}`
                  : null,
              configuredPrecision == null
                ? "token precision is missing"
                : configuredPrecision !== nativeDecimals
                  ? `outpost precision is ${configuredPrecision}, expected ${nativeDecimals}`
                  : null,
              token.precision !== WireReserveTool.depotPrecision(nativeDecimals)
                ? `depot token precision is ${token.precision}, expected ${WireReserveTool.depotPrecision(nativeDecimals)}`
                : null,
              reserve.source_token_precision !==
              WireReserveTool.depotPrecision(nativeDecimals)
                ? `depot reserve precision is ${reserve.source_token_precision}, expected ${WireReserveTool.depotPrecision(nativeDecimals)}`
                : null,
              !isSolanaReserveActive(localReserve)
                ? "local reserve status is not ACTIVE"
                : null,
              localReserve.tokenCode.toString() !== tokenCode.toString() ||
              localReserve.reserveCode.toString() !== reserveCode.toString()
                ? "local reserve identity does not match the depot row"
                : null,
              !localReserve.custodyMint.equals(expectedMint)
                ? `reserve custody mint is ${localReserve.custodyMint.toBase58()}, expected ${expectedMint.toBase58()}`
                : null,
              localReserve.custodyDecimals !== nativeDecimals
                ? `reserve custody precision is ${localReserve.custodyDecimals}, expected ${nativeDecimals}`
                : null
            ].filter((issue): issue is string => issue != null),
            fundingIssues = [
              balance <= 0n ? "external custody balance is zero" : null,
              localReserve.externalTokenAmount.lte(new BN(0))
                ? "local reserve amount is zero"
                : null
            ].filter((issue): issue is string => issue != null)

          return probe(
            reserve,
            configurationIssues,
            fundingIssues,
            balance.toString()
          )
        } catch (error: unknown) {
          log.warn(
            `Solana reserve custody probe failed for ${readinessReserveLabel(reserve)}: ${readinessErrorMessage(error)}`
          )
          return failedProbe(reserve, [readinessErrorMessage(error)])
        }
      })
    )
  } catch (error: unknown) {
    log.warn(
      `Solana reserve custody discovery failed: ${readinessErrorMessage(error)}`
    )
    return reserves.map(reserve =>
      failedProbe(reserve, [readinessErrorMessage(error)])
    )
  }
}

function reserveHasChainKind(
  state: ExternalReserveCustodyState,
  reserve: SysioContracts.SysioReservReserveRowType,
  numeric: SysioContracts.SysioChainsChainkind,
  name: string
): boolean {
  return state.chains.some(
    chain =>
      chain.active &&
      readinessSlugValue(chain.code) ===
        readinessSlugValue(reserve.chain_code) &&
      readinessEnumMatches(chain.kind, numeric, name)
  )
}

function assertChainToken(
  state: ExternalReserveCustodyState,
  reserve: SysioContracts.SysioReservReserveRowType
): SysioContracts.SysioTokensChainTokenRowType {
  const chainToken = state.chainTokens.find(
    candidate =>
      candidate.active &&
      readinessSlugValue(candidate.chain_code) ===
        readinessSlugValue(reserve.chain_code) &&
      readinessSlugValue(candidate.token_code) ===
        readinessSlugValue(reserve.token_code)
  )
  if (!chainToken) throw new Error("active chain-token binding is missing")
  return chainToken
}

function assertToken(
  state: ExternalReserveCustodyState,
  reserve: SysioContracts.SysioReservReserveRowType
): SysioContracts.SysioTokensTokenRowType {
  const token = state.tokens.find(
    candidate =>
      candidate.active &&
      readinessSlugValue(candidate.code) ===
        readinessSlugValue(reserve.token_code)
  )
  if (!token) throw new Error("active token definition is missing")
  return token
}

async function readEthereumTokenDecimals(
  context: ReadinessContext,
  endpoint: string,
  address: string
): Promise<number> {
  const result = await context.jsonRpc<string>(
    endpoint,
    EthereumRpcMethod.call,
    [{ to: address, data: EthereumDecimalsCallData }, EthereumBlockTag.latest]
  )
  return Number(BigInt(result))
}

async function readSolanaAccount(
  context: ReadinessContext,
  endpoint: string,
  address: PublicKey
): Promise<SolanaRpcAccount> {
  const result = await context.jsonRpc<SolanaAccountInfoResponse>(
    endpoint,
    SolanaRpcMethod.getAccountInfo,
    [
      address.toBase58(),
      {
        commitment: SolanaCommitment.confirmed,
        encoding: SolanaEncoding.base64
      }
    ]
  )
  if (!result.value) throw new Error(`Solana account ${address} is missing`)
  return result.value
}

async function readSolanaVaultBalance(
  context: ReadinessContext,
  endpoint: string,
  address: PublicKey
): Promise<bigint> {
  const result = await context.jsonRpc<SolanaTokenBalanceResponse>(
    endpoint,
    SolanaRpcMethod.getTokenAccountBalance,
    [address.toBase58(), { commitment: SolanaCommitment.confirmed }]
  )
  return BigInt(result.value.amount)
}

function decodeAccount<T>(
  coder: BorshAccountsCoder,
  name: keyof Program<LiqsolCore>["account"],
  account: SolanaRpcAccount
): T {
  return coder.decode<T>(
    name,
    Buffer.from(account.data[0], SolanaEncoding.base64)
  )
}

function deriveAddress(programId: PublicKey, seeds: Buffer[]): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0]
}

function deriveReserveAddress(
  programId: PublicKey,
  seed: Buffer,
  tokenCode: bigint,
  reserveCode: bigint
): PublicKey {
  return deriveAddress(programId, [
    seed,
    unsigned64Seed(tokenCode),
    unsigned64Seed(reserveCode)
  ])
}

function unsigned64Seed(value: bigint): Buffer {
  return new BN(value.toString()).toArrayLike(
    Buffer,
    "le",
    Unsigned64ByteLength
  )
}

function isSolanaReserveActive(reserve: SolanaReserve): boolean {
  return match(reserve.status)
    .with({ active: P.any }, () => true)
    .otherwise(() => false)
}

function getAddressWithPrefix(address: string): string {
  return getAddress(address.startsWith("0x") ? address : `0x${address}`)
}

function solanaPublicKey(address: string): string {
  if (/^[0-9a-f]{64}$/i.test(address))
    return new PublicKey(Buffer.from(address, "hex")).toBase58()
  return new PublicKey(address).toBase58()
}

function probe(
  reserve: SysioContracts.SysioReservReserveRowType,
  configurationIssues: string[],
  fundingIssues: string[],
  balance: string
): ReadinessExternalCustodyReserve {
  const configured = configurationIssues.length === 0,
    funded = fundingIssues.length === 0
  return {
    chainCode: readinessSlugValue(reserve.chain_code),
    tokenCode: readinessSlugValue(reserve.token_code),
    reserveCode: readinessSlugValue(reserve.reserve_code),
    label: readinessReserveLabel(reserve),
    configured,
    funded,
    ready: configured && funded,
    issues: [...configurationIssues, ...fundingIssues],
    balance
  }
}

function failedProbe(
  reserve: SysioContracts.SysioReservReserveRowType,
  issues: string[]
): ReadinessExternalCustodyReserve {
  return probe(reserve, issues, ["external custody funding is unverified"], "0")
}
