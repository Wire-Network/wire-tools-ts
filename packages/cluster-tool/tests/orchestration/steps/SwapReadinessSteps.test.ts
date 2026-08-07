import {
  ClusterReadinessCheckStatus,
  ClusterReadinessFeature
} from "@wireio/cluster-tool-shared"
import { getLogger } from "@wireio/cluster-tool/logging"
import { Steps } from "@wireio/cluster-tool/orchestration"
import {
  ExternalReserveCustodyReader,
  ReadinessContext,
  ReadinessOutputs
} from "@wireio/cluster-tool/readiness"
import { Report } from "@wireio/cluster-tool/report"
import { SlugName, SysioContracts } from "@wireio/sdk-core"

const FullCollateral = 1_000_000_000,
  EthereumChainCode = { value: SlugName.from("ETHEREUM") },
  SolanaChainCode = { value: SlugName.from("SOLANA") },
  EthereumTokenCode = { value: SlugName.from("ETH") },
  SolanaTokenCode = { value: SlugName.from("SOL") },
  PrimaryReserveCode = { value: SlugName.from("PRIMARY") },
  CollateralRequirements: SysioContracts.SysioOpregChainMinBondType[] = [
    {
      chain_code: EthereumChainCode,
      token_code: EthereumTokenCode,
      min_bond: FullCollateral,
      config_timestamp_ms: 0
    },
    {
      chain_code: SolanaChainCode,
      token_code: SolanaTokenCode,
      min_bond: FullCollateral,
      config_timestamp_ms: 0
    }
  ],
  ActiveExternalChains: SysioContracts.SysioChainsChainRowType[] = [
    {
      code: EthereumChainCode,
      kind: SysioContracts.SysioChainsChainkind.CHAIN_KIND_EVM,
      external_chain_id: 31_337,
      name: "Ethereum",
      description: "Ethereum outpost",
      is_depot: false,
      active: true,
      registered_at_ms: 0,
      activated_at_ms: 0
    },
    {
      code: SolanaChainCode,
      kind: SysioContracts.SysioChainsChainkind.CHAIN_KIND_SVM,
      external_chain_id: 0,
      name: "Solana",
      description: "Solana outpost",
      is_depot: false,
      active: true,
      registered_at_ms: 0,
      activated_at_ms: 0
    }
  ],
  OperatorConfig: SysioContracts.SysioOpregOpConfigType = {
    req_prod_collat: [],
    req_batchop_collat: [],
    req_uw_collat: CollateralRequirements,
    max_available_producers: 1,
    max_available_batch_ops: 1,
    max_available_underwriters: 1,
    terminate_prune_delay_ms: 0,
    terminate_max_consecutive_misses: 1,
    terminate_max_pct_misses_24h: 1,
    terminate_window_ms: 1
  },
  ActiveChainTokens: SysioContracts.SysioTokensChainTokenRowType[] = [
    {
      chain_code: EthereumChainCode,
      token_code: EthereumTokenCode,
      contract_addr: "",
      is_native: true,
      active: true,
      registered_at_ms: 0,
      activated_at_ms: 0
    },
    {
      chain_code: SolanaChainCode,
      token_code: SolanaTokenCode,
      contract_addr: "",
      is_native: true,
      active: true,
      registered_at_ms: 0,
      activated_at_ms: 0
    }
  ],
  ActiveTokens: SysioContracts.SysioTokensTokenRowType[] = [
    {
      code: EthereumTokenCode,
      kind: SysioContracts.SysioTokensTokenkind.TOKEN_KIND_NATIVE,
      symbol_name: "ETH",
      description: "Ethereum native token",
      precision: 9,
      address: {
        kind: SysioContracts.SysioTokensChainkind.CHAIN_KIND_UNKNOWN,
        address: ""
      },
      active: true,
      registered_at_ms: 0,
      activated_at_ms: 0
    },
    {
      code: SolanaTokenCode,
      kind: SysioContracts.SysioTokensTokenkind.TOKEN_KIND_NATIVE,
      symbol_name: "SOL",
      description: "Solana native token",
      precision: 9,
      address: {
        kind: SysioContracts.SysioTokensChainkind.CHAIN_KIND_UNKNOWN,
        address: ""
      },
      active: true,
      registered_at_ms: 0,
      activated_at_ms: 0
    }
  ]

interface ReadinessFixtures {
  chains: SysioContracts.SysioChainsChainRowType[]
  chainTokens: SysioContracts.SysioTokensChainTokenRowType[]
  tokens: SysioContracts.SysioTokensTokenRowType[]
  reserves: SysioContracts.SysioReservReserveRowType[]
  operatorConfig: SysioContracts.SysioOpregOpConfigType
  operators: SysioContracts.SysioOpregOperatorEntryType[]
  locks: SysioContracts.SysioUwritLockEntryType[]
  withdrawals: SysioContracts.SysioOpregWithdrawRequestType[]
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
    reserve_chain_amount: FullCollateral,
    reserve_wire_amount: FullCollateral,
    source_token_precision: 9,
    connector_weight_bps: 5_000,
    creator_addr: {
      kind: SysioContracts.SysioReservChainkind.CHAIN_KIND_UNKNOWN,
      address: ""
    },
    requested_wire_amount: FullCollateral,
    external_token_amount: FullCollateral,
    registered_at_ms: 0,
    activated_at_ms: 0,
    cancelled_at_ms: 0,
    is_private: false,
    owner: "",
    creator_pub_key: ""
  }
}

const ActivePublicReserves = [
  reserve(EthereumChainCode, EthereumTokenCode),
  reserve(SolanaChainCode, SolanaTokenCode)
]

function underwriter(
  status: SysioContracts.SysioOpregOperatorEntryType["status"]
): SysioContracts.SysioOpregOperatorEntryType {
  return {
    account: "wireno.wacca",
    type: SysioContracts.SysioOpregOperatortype.OPERATOR_TYPE_UNDERWRITER,
    status,
    is_bootstrapped: false,
    balances: CollateralRequirements.map(requirement => ({
      chain_code: requirement.chain_code,
      token_code: requirement.token_code,
      balance: FullCollateral,
      last_updated_ms: 0
    })),
    registered_at: 0,
    available_at: 0,
    updated_at: 0,
    terminated_at: 0,
    status_reason: "",
    recent_actions: []
  }
}

function readinessContext(
  fixtures: Partial<ReadinessFixtures>
): ReadinessContext {
  const {
      chains = ActiveExternalChains,
      chainTokens = ActiveChainTokens,
      tokens = ActiveTokens,
      reserves = ActivePublicReserves,
      operatorConfig = OperatorConfig,
      operators = [],
      locks = [],
      withdrawals = []
    } = fixtures,
    context = new ReadinessContext(
      {
        feature: ClusterReadinessFeature.swap,
        catalogUrl: "https://catalog.example",
        requestedWireChainId: "a".repeat(64),
        endpoints: [],
        catalogRecordCount: 0,
        catalogErrors: [],
        observationMs: 1,
        timeoutMs: 1,
        report: { path: "/tmp", basename: "readiness", formats: [] }
      },
      getLogger("swap-readiness-steps-test")
    )
  jest
    .spyOn(context.wireSystem.opreg.tables.opconfig, "query")
    .mockResolvedValue({ rows: [operatorConfig], more: false })
  jest
    .spyOn(context.wireSystem.opreg.tables.operators, "query")
    .mockResolvedValue({ rows: operators, more: false })
  jest
    .spyOn(context.wireSystem.chains.tables.chains, "query")
    .mockResolvedValue({ rows: chains, more: false })
  jest
    .spyOn(context.wireSystem.tokens.tables.chaintokens, "query")
    .mockResolvedValue({ rows: chainTokens, more: false })
  jest
    .spyOn(context.wireSystem.tokens.tables.tokens, "query")
    .mockResolvedValue({ rows: tokens, more: false })
  jest
    .spyOn(context.wireSystem.reserv.tables.reserves, "query")
    .mockResolvedValue({ rows: reserves, more: false })
  jest
    .spyOn(context.wireSystem.uwrit.tables.locks, "query")
    .mockResolvedValue({ rows: locks, more: false })
  jest
    .spyOn(context.wireSystem.opreg.tables.wtdwqueue, "query")
    .mockResolvedValue({ rows: withdrawals, more: false })
  return context
}

function activeUnderwritersStep() {
  return Steps.readiness.swap.planActiveUnderwriters(
    Report.Actor.Underwriter,
    "active-underwriters",
    "Verify an active underwriter satisfies the collateral matrix",
    {}
  )
}

function externalCustodyStep() {
  return Steps.readiness.swap.planExternalCustody(
    Report.Actor.Sysio,
    "external-custody",
    "Verify every advertised external reserve",
    {}
  )
}

function assetRegistryStep() {
  return Steps.readiness.swap.planAssetRegistry(
    Report.Actor.Sysio,
    "asset-registry",
    "Verify every advertised reserve has an active token binding",
    {}
  )
}

function publicReservesStep() {
  return Steps.readiness.swap.planPublicReserves(
    Report.Actor.Sysio,
    "public-reserves",
    "Verify every advertised reserve has positive depot liquidity",
    {}
  )
}

function routeRegistryStep() {
  return Steps.readiness.swap.planRouteRegistry(
    Report.Actor.Sysio,
    "route-registry",
    "Build every advertised direction",
    {}
  )
}

function routeQuotesStep() {
  return Steps.readiness.swap.planRouteQuotes(
    Report.Actor.Sysio,
    "route-quotes",
    "Verify every advertised direction returns a positive quote",
    {}
  )
}

function primeRouteEvidence(
  context: ReadinessContext,
  reserves: SysioContracts.SysioReservReserveRowType[]
): void {
  context.outputs.set(
    ReadinessOutputs.externalCustodyReserves,
    reserves.map(reserve => ({
      chainCode: Number(reserve.chain_code.value),
      tokenCode: Number(reserve.token_code.value),
      reserveCode: Number(reserve.reserve_code.value),
      label: `${reserve.chain_code.value}/${reserve.token_code.value}/${reserve.reserve_code.value}`,
      configured: true,
      funded: true,
      ready: true,
      issues: [],
      balance: String(FullCollateral)
    }))
  )
  context.outputs.set(
    ReadinessOutputs.collateralBuckets,
    CollateralRequirements.map(requirement => ({
      chainCode: Number(requirement.chain_code.value),
      tokenCode: Number(requirement.token_code.value),
      label: `${requirement.chain_code.value}/${requirement.token_code.value}`,
      minimum: String(requirement.min_bond),
      accounts: ["wireno.wacca"],
      ready: true,
      issues: []
    }))
  )
}

describe("SwapReadinessSteps", () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it("accepts a non-bootstrapped ACTIVE underwriter with full collateral", async () => {
    const context = readinessContext({
        operators: [
          underwriter(
            SysioContracts.SysioOpregOperatorstatus.OPERATOR_STATUS_ACTIVE
          )
        ]
      }),
      step = activeUnderwritersStep()

    await step.runner(context, step.input, new AbortController().signal)

    expect(context.outputs.assert(ReadinessOutputs.checks)).toEqual([
      expect.objectContaining({
        status: ClusterReadinessCheckStatus.pass,
        evidence: expect.objectContaining({
          accounts: ["wireno.wacca"],
          activeLocks: 0,
          pendingWithdrawals: 0
        })
      })
    ])
    expect(context.outputs.assert(ReadinessOutputs.collateralBuckets)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chainCode: EthereumChainCode.value,
          tokenCode: EthereumTokenCode.value,
          accounts: ["wireno.wacca"],
          ready: true
        }),
        expect.objectContaining({
          chainCode: SolanaChainCode.value,
          tokenCode: SolanaTokenCode.value,
          accounts: ["wireno.wacca"],
          ready: true
        })
      ])
    )
  })

  it("rejects a fully collateralized underwriter that is not ACTIVE", async () => {
    const context = readinessContext({
        operators: [
          underwriter(
            SysioContracts.SysioOpregOperatorstatus.OPERATOR_STATUS_WARMUP
          )
        ]
      }),
      step = activeUnderwritersStep()

    await expect(
      step.runner(context, step.input, new AbortController().signal)
    ).rejects.toThrow(
      "No ACTIVE underwriter has sufficient available collateral for every advertised token bucket"
    )
    expect(context.outputs.assert(ReadinessOutputs.checks)).toEqual([
      expect.objectContaining({
        status: ClusterReadinessCheckStatus.fail,
        evidence: expect.objectContaining({ activeUnderwriters: [] })
      })
    ])
  })

  it("rejects an advertised token bucket without a collateral requirement", async () => {
    const context = readinessContext({
        operatorConfig: {
          ...OperatorConfig,
          req_uw_collat: [CollateralRequirements[0]]
        },
        operators: [
          underwriter(
            SysioContracts.SysioOpregOperatorstatus.OPERATOR_STATUS_ACTIVE
          )
        ]
      }),
      step = activeUnderwritersStep()

    await expect(
      step.runner(context, step.input, new AbortController().signal)
    ).rejects.toThrow("Underwriter collateral requirements are incomplete")
    expect(
      context.outputs
        .assert(ReadinessOutputs.collateralBuckets)
        .find(bucket => bucket.tokenCode === SolanaTokenCode.value)
    ).toEqual(
      expect.objectContaining({
        ready: false,
        issues: ["collateral requirement is missing"]
      })
    )
  })

  it("subtracts active locks and pending withdrawals from collateral availability", async () => {
    const context = readinessContext({
        operators: [
          underwriter(
            SysioContracts.SysioOpregOperatorstatus.OPERATOR_STATUS_ACTIVE
          )
        ],
        locks: [
          {
            lock_id: 1,
            uwreq_id: 1,
            underwriter: "wireno.wacca",
            chain_code: EthereumChainCode,
            token_code: EthereumTokenCode,
            reserve_code: PrimaryReserveCode,
            amount: 1,
            created_at_ms: 0,
            expires_at_ms: 1
          }
        ],
        withdrawals: [
          {
            request_id: 1,
            account: "wireno.wacca",
            chain_code: SolanaChainCode,
            token_code: SolanaTokenCode,
            amount: 1,
            eligible_at_epoch: 1,
            requested_at_epoch: 0
          }
        ]
      }),
      step = activeUnderwritersStep()

    await expect(
      step.runner(context, step.input, new AbortController().signal)
    ).rejects.toThrow(
      "No ACTIVE underwriter has sufficient available collateral"
    )
    expect(context.outputs.assert(ReadinessOutputs.collateralBuckets)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chainCode: EthereumChainCode.value,
          accounts: [],
          ready: false
        }),
        expect.objectContaining({
          chainCode: SolanaChainCode.value,
          accounts: [],
          ready: false
        })
      ])
    )
  })

  it("accepts aligned and funded external custody probes", async () => {
    const context = readinessContext({}),
      probes = ActivePublicReserves.map(reserve => ({
        chainCode: Number(reserve.chain_code.value),
        tokenCode: Number(reserve.token_code.value),
        reserveCode: Number(reserve.reserve_code.value),
        label: `${reserve.chain_code.value}/${reserve.token_code.value}/${reserve.reserve_code.value}`,
        configured: true,
        funded: true,
        ready: true,
        issues: [],
        balance: String(FullCollateral)
      })),
      read = jest
        .spyOn(ExternalReserveCustodyReader, "read")
        .mockResolvedValue(probes),
      step = externalCustodyStep()

    await step.runner(context, step.input, new AbortController().signal)

    expect(read).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ reserves: ActivePublicReserves })
    )
    expect(context.outputs.assert(ReadinessOutputs.checks)).toEqual([
      expect.objectContaining({
        status: ClusterReadinessCheckStatus.pass,
        evidence: { reserves: probes }
      })
    ])
  })

  it("rejects a reserve with misconfigured external custody", async () => {
    const context = readinessContext({}),
      failedProbe = {
        chainCode: EthereumChainCode.value,
        tokenCode: EthereumTokenCode.value,
        reserveCode: PrimaryReserveCode.value,
        label: "ETHEREUM/ETH/PRIMARY",
        configured: false,
        funded: false,
        ready: false,
        issues: ["local reserve record is missing"],
        balance: "0"
      },
      step = externalCustodyStep()

    jest
      .spyOn(ExternalReserveCustodyReader, "read")
      .mockResolvedValue([failedProbe])

    await expect(
      step.runner(context, step.input, new AbortController().signal)
    ).rejects.toThrow(
      "External custody configuration failed for ETHEREUM/ETH/PRIMARY"
    )
    expect(context.outputs.assert(ReadinessOutputs.checks)).toEqual([
      expect.objectContaining({
        status: ClusterReadinessCheckStatus.fail,
        evidence: { reserves: [failedProbe] }
      })
    ])
  })

  it("rejects an unbound advertised reserve even when its depot depth is zero", async () => {
    const zeroDepthSolanaReserve = {
        ...ActivePublicReserves[1],
        reserve_chain_amount: 0
      },
      context = readinessContext({
        chainTokens: ActiveChainTokens.map(binding =>
          binding.chain_code === SolanaChainCode
            ? { ...binding, active: false }
            : binding
        ),
        reserves: [ActivePublicReserves[0], zeroDepthSolanaReserve]
      }),
      step = assetRegistryStep()

    await expect(
      step.runner(context, step.input, new AbortController().signal)
    ).rejects.toThrow(
      "1 advertised public reserve(s) lack an active chain-token binding"
    )
  })

  it("rejects every advertised public reserve with a zero depot depth", async () => {
    const zeroDepthSolanaReserve = {
        ...ActivePublicReserves[1],
        reserve_wire_amount: 0
      },
      context = readinessContext({
        reserves: [ActivePublicReserves[0], zeroDepthSolanaReserve]
      }),
      step = publicReservesStep()

    await expect(
      step.runner(context, step.input, new AbortController().signal)
    ).rejects.toThrow("Advertised public reserves have zero liquidity")
    expect(context.outputs.assert(ReadinessOutputs.checks)).toEqual([
      expect.objectContaining({
        status: ClusterReadinessCheckStatus.fail,
        evidence: expect.objectContaining({
          zeroDepthReserves: [expect.stringContaining("PRIMARY")]
        })
      })
    ])
  })

  it("keeps an advertised zero-depth reserve in the route matrix and fails its quotes", async () => {
    const zeroDepthSolanaReserve = {
        ...ActivePublicReserves[1],
        reserve_chain_amount: 0
      },
      reserves = [ActivePublicReserves[0], zeroDepthSolanaReserve],
      context = readinessContext({ reserves }),
      registryStep = routeRegistryStep(),
      quotesStep = routeQuotesStep()

    primeRouteEvidence(context, reserves)
    await registryStep.runner(
      context,
      registryStep.input,
      new AbortController().signal
    )

    const routes = context.outputs.assert(ReadinessOutputs.routes)
    expect(routes).toHaveLength(6)
    expect(routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "SOL on Solana",
          destination: "WIRE",
          quotedDestinationAmount: "0",
          preflightReady: false
        })
      ])
    )
    await expect(
      quotesStep.runner(context, quotesStep.input, new AbortController().signal)
    ).rejects.toThrow(
      "directional route(s) fail infrastructure preflight or return a zero quote"
    )
  })
})
