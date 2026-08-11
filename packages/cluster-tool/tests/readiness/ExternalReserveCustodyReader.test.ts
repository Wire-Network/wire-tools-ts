import { BN, BorshAccountsCoder, type IdlAccounts } from "@coral-xyz/anchor"
import { JsonRpcProvider } from "@ethersproject/providers"
import { PublicKey } from "@solana/web3.js"
import {
  ClusterReadinessEndpointKind,
  ClusterReadinessEndpointSource,
  ClusterReadinessFeature
} from "@wireio/cluster-tool-shared"
import { BindConfigProvider } from "@wireio/cluster-tool/config"
import { getLogger } from "@wireio/cluster-tool/logging"
import {
  ExternalReserveCustodyReader,
  ReadinessContext,
  type ExternalReserveCustodyState,
  type SolanaAccountInfoResponse
} from "@wireio/cluster-tool/readiness"
import { toURL } from "@wireio/cluster-tool/utils"
import { SlugName, SysioContracts } from "@wireio/sdk-core"
import {
  type LiqsolCore,
  liqsolCoreIdl,
  ReserveManager__factory
} from "@wireio/sdk-outpost"
import { ZeroAddress } from "ethers"

import {
  createReadinessDeploymentProfileFixture,
  ReadinessWireChainId
} from "./readinessProfileFixture.js"

const EthereumChainCode = { value: SlugName.from("ETHEREUM") },
  SolanaChainCode = { value: SlugName.from("SOLANA") },
  EthereumTokenCode = { value: SlugName.from("ETH") },
  SolanaTokenCode = { value: SlugName.from("SOL") },
  PrimaryReserveCode = { value: SlugName.from("PRIMARY") },
  CustodyAmount = 1_000_000_000,
  EthereumNativeDecimals = 18,
  SolanaNativeDecimals = 9

type SolanaOutpostConfig = IdlAccounts<LiqsolCore>["outpostConfig"]
type SolanaReserve = IdlAccounts<LiqsolCore>["reserve"]

interface EthereumProbeFixture {
  exists: boolean
  amount: number
}

let ethereumUrl: string, solanaUrl: string

beforeAll(async () => {
  ethereumUrl = toURL(
    await BindConfigProvider.findAvailable(BindConfigProvider.DefaultAnvil)
  )
  solanaUrl = toURL(
    await BindConfigProvider.findAvailable(BindConfigProvider.DefaultSolanaRpc)
  )
})

afterEach(() => {
  jest.restoreAllMocks()
})

function chain(
  code: SysioContracts.SysioChainsSlugNameType,
  kind: SysioContracts.SysioChainsChainkind,
  name: string
): SysioContracts.SysioChainsChainRowType {
  return {
    code,
    kind,
    external_chain_id:
      kind === SysioContracts.SysioChainsChainkind.CHAIN_KIND_EVM ? 31_337 : 0,
    name,
    description: `${name} outpost`,
    is_depot: false,
    active: true,
    registered_at_ms: 0,
    activated_at_ms: 0
  }
}

function chainToken(
  chainCode: SysioContracts.SysioTokensSlugNameType,
  tokenCode: SysioContracts.SysioTokensSlugNameType
): SysioContracts.SysioTokensChainTokenRowType {
  return {
    chain_code: chainCode,
    token_code: tokenCode,
    contract_addr: "",
    is_native: true,
    active: true,
    registered_at_ms: 0,
    activated_at_ms: 0
  }
}

function token(
  code: SysioContracts.SysioTokensSlugNameType,
  symbolName: string
): SysioContracts.SysioTokensTokenRowType {
  return {
    code,
    kind: SysioContracts.SysioTokensTokenkind.TOKEN_KIND_NATIVE,
    symbol_name: symbolName,
    description: `${symbolName} native token`,
    precision: 9,
    address: {
      kind: SysioContracts.SysioTokensChainkind.CHAIN_KIND_UNKNOWN,
      address: ""
    },
    active: true,
    registered_at_ms: 0,
    activated_at_ms: 0
  }
}

function reserve(
  chainCode: SysioContracts.SysioReservSlugNameType,
  tokenCode: SysioContracts.SysioReservSlugNameType
): SysioContracts.SysioReservReserveRowType {
  return {
    chain_code: chainCode,
    token_code: tokenCode,
    reserve_code: PrimaryReserveCode,
    name: "Primary",
    description: "Public reserve",
    status: SysioContracts.SysioReservReservestatus.RESERVE_STATUS_ACTIVE,
    reserve_chain_amount: CustodyAmount,
    reserve_wire_amount: CustodyAmount,
    source_token_precision: 9,
    connector_weight_bps: 5_000,
    creator_addr: {
      kind: SysioContracts.SysioReservChainkind.CHAIN_KIND_UNKNOWN,
      address: ""
    },
    requested_wire_amount: CustodyAmount,
    external_token_amount: CustodyAmount,
    registered_at_ms: 0,
    activated_at_ms: 0,
    cancelled_at_ms: 0,
    is_private: false,
    owner: "",
    creator_pub_key: ""
  }
}

function state(
  chainRow: SysioContracts.SysioChainsChainRowType,
  binding: SysioContracts.SysioTokensChainTokenRowType,
  tokenRow: SysioContracts.SysioTokensTokenRowType,
  reserveRow: SysioContracts.SysioReservReserveRowType
): ExternalReserveCustodyState {
  return {
    chains: [chainRow],
    chainTokens: [binding],
    tokens: [tokenRow],
    reserves: [reserveRow]
  }
}

function context(
  kind: ClusterReadinessEndpointKind,
  url: string,
  request: typeof fetch = globalThis.fetch
): ReadinessContext {
  return new ReadinessContext(
    {
      feature: ClusterReadinessFeature.swap,
      catalogUrl: "https://catalog.example",
      requestedWireChainId: ReadinessWireChainId,
      outpostDeploymentProfile: createReadinessDeploymentProfileFixture(),
      endpoints: [
        {
          kind,
          url,
          source: ClusterReadinessEndpointSource.explicit
        }
      ],
      catalogRecordCount: 0,
      catalogErrors: [],
      observationMs: 1,
      timeoutMs: 1_000,
      report: { path: "/tmp", basename: "readiness", formats: [] }
    },
    getLogger("external-reserve-custody-reader-test"),
    request
  )
}

function ethereumState(): ExternalReserveCustodyState {
  return state(
    chain(
      EthereumChainCode,
      SysioContracts.SysioChainsChainkind.CHAIN_KIND_EVM,
      "Ethereum"
    ),
    chainToken(EthereumChainCode, EthereumTokenCode),
    token(EthereumTokenCode, "ETH"),
    reserve(EthereumChainCode, EthereumTokenCode)
  )
}

function solanaState(): ExternalReserveCustodyState {
  return state(
    chain(
      SolanaChainCode,
      SysioContracts.SysioChainsChainkind.CHAIN_KIND_SVM,
      "Solana"
    ),
    chainToken(SolanaChainCode, SolanaTokenCode),
    token(SolanaTokenCode, "SOL"),
    reserve(SolanaChainCode, SolanaTokenCode)
  )
}

function mockEthereumCalls(fixture: EthereumProbeFixture) {
  const managerInterface = ReserveManager__factory.createInterface(),
    encoded = [
      managerInterface.encodeFunctionResult("nativeTokenCode", [
        EthereumTokenCode.value
      ]),
      managerInterface.encodeFunctionResult("trackedCodesCount", [1]),
      managerInterface.encodeFunctionResult("trackedTokenCodes", [
        EthereumTokenCode.value
      ]),
      managerInterface.encodeFunctionResult("trackedReserveCodes", [
        PrimaryReserveCode.value
      ]),
      managerInterface.encodeFunctionResult("tokenAddressesByCode", [
        ZeroAddress
      ]),
      managerInterface.encodeFunctionResult("tokenPrecisionByCode", [
        EthereumNativeDecimals
      ]),
      managerInterface.encodeFunctionResult("getReserve", [
        [
          EthereumTokenCode.value,
          PrimaryReserveCode.value,
          fixture.amount,
          fixture.amount,
          5_000,
          1,
          ZeroAddress,
          fixture.exists
        ]
      ]),
      managerInterface.encodeFunctionResult("balanceOf", [fixture.amount])
    ],
    rpcCall = jest.spyOn(JsonRpcProvider.prototype, "call")

  encoded.forEach(result => rpcCall.mockResolvedValueOnce(result))
  return rpcCall
}

function solanaConfig(): SolanaOutpostConfig {
  return {
    chainCode: new BN(SolanaChainCode.value),
    nextEpochIndex: 0,
    previousEpochHash: Array(32).fill(0),
    previousOutboundEpochHash: Array(32).fill(0),
    epochDurationSec: 60,
    currentEpochStartedAt: new BN(0),
    registryInitialized: true,
    lastMessageId: Array(32).fill(0),
    lastMessageTimestamp: new BN(0),
    envelopeRetentionEpochs: 10,
    tokenAddressesByCode: [
      {
        tokenCode: new BN(SolanaTokenCode.value),
        mint: PublicKey.default
      }
    ],
    precisionByTokenCode: [
      {
        tokenCode: new BN(SolanaTokenCode.value),
        decimals: SolanaNativeDecimals
      }
    ],
    configVersion: 1,
    bump: 255
  }
}

function solanaReserve(): SolanaReserve {
  return {
    tokenCode: new BN(SolanaTokenCode.value),
    reserveCode: new BN(PrimaryReserveCode.value),
    externalTokenAmount: new BN(CustodyAmount),
    requestedWireAmount: new BN(CustodyAmount),
    connectorWeightBps: 5_000,
    status: { active: {} },
    creator: PublicKey.default,
    custodyMint: PublicKey.default,
    custodyDecimals: SolanaNativeDecimals,
    nameLen: 0,
    nameBytes: Array(64).fill(0),
    descriptionLen: 0,
    descriptionBytes: Array(256).fill(0),
    bump: 255
  }
}

function solanaAccount(
  data: Buffer,
  lamports = CustodyAmount
): SolanaAccountInfoResponse {
  return {
    value: {
      data: [data.toString("base64"), "base64"],
      executable: false,
      lamports,
      owner: PublicKey.default.toBase58(),
      rentEpoch: 0,
      space: data.byteLength
    }
  }
}

function requestWithResults(
  results: SolanaAccountInfoResponse[]
): typeof fetch {
  const remaining = [...results]
  return jest.fn(async () =>
    Response.json({ jsonrpc: "2.0", id: 1, result: remaining.shift() })
  )
}

describe("ExternalReserveCustodyReader", () => {
  it("accepts an initialized and funded native Ethereum reserve", async () => {
    const rpcCall = mockEthereumCalls({
        exists: true,
        amount: CustodyAmount
      }),
      probes = await ExternalReserveCustodyReader.read(
        context(ClusterReadinessEndpointKind.ethereum, ethereumUrl),
        ethereumState()
      )

    expect(rpcCall).toHaveBeenCalledTimes(8)
    expect(probes).toEqual([
      expect.objectContaining({
        label: "ETHEREUM/ETH/PRIMARY",
        configured: true,
        funded: true,
        ready: true,
        balance: String(CustodyAmount),
        issues: []
      })
    ])
  })

  it("rejects a missing and unfunded native Ethereum reserve", async () => {
    mockEthereumCalls({ exists: false, amount: 0 })

    const probes = await ExternalReserveCustodyReader.read(
      context(ClusterReadinessEndpointKind.ethereum, ethereumUrl),
      ethereumState()
    )

    expect(probes).toEqual([
      expect.objectContaining({
        configured: false,
        funded: false,
        ready: false,
        issues: expect.arrayContaining([
          "local reserve record is missing",
          "external custody balance is zero",
          "local reserve amount is zero"
        ])
      })
    ])
  })

  it("accepts an initialized and funded native Solana reserve", async () => {
    const coder = new BorshAccountsCoder(liqsolCoreIdl),
      configData = await coder.encode("outpostConfig", solanaConfig()),
      reserveData = await coder.encode("reserve", solanaReserve()),
      request = requestWithResults([
        solanaAccount(configData),
        solanaAccount(reserveData)
      ]),
      probes = await ExternalReserveCustodyReader.read(
        context(ClusterReadinessEndpointKind.solana, solanaUrl, request),
        solanaState()
      )

    expect(request).toHaveBeenCalledTimes(2)
    expect(probes).toEqual([
      expect.objectContaining({
        label: "SOLANA/SOL/PRIMARY",
        configured: true,
        funded: true,
        ready: true,
        balance: String(CustodyAmount),
        issues: []
      })
    ])
  })

  it("rejects an uninitialized Solana reserve account", async () => {
    const coder = new BorshAccountsCoder(liqsolCoreIdl),
      configData = await coder.encode("outpostConfig", solanaConfig()),
      request = requestWithResults([
        solanaAccount(configData),
        { value: null }
      ]),
      probes = await ExternalReserveCustodyReader.read(
        context(ClusterReadinessEndpointKind.solana, solanaUrl, request),
        solanaState()
      )

    expect(probes).toEqual([
      expect.objectContaining({
        configured: false,
        funded: false,
        ready: false,
        issues: expect.arrayContaining([
          expect.stringContaining("Solana account"),
          "external custody funding is unverified"
        ])
      })
    ])
  })
})
