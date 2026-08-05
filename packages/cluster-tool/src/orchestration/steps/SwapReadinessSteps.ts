import { Base58, SysioContracts } from "@wireio/sdk-core"
import {
  ClusterReadinessArea,
  ClusterReadinessCheckId,
  ClusterReadinessEndpointKind,
  ClusterReadinessReasonCode,
  type ClusterSwapRouteReadiness
} from "@wireio/cluster-tool-shared"

import {
  ReadinessAssertionError,
  ReadinessContext
} from "../../readiness/ReadinessContext.js"
import { ReadinessConfig } from "../../readiness/ReadinessConfig.js"
import { ReadinessOutputs } from "../../readiness/ReadinessOutputs.js"
import {
  ReadinessMaxTableRows,
  readinessBoundedQuery,
  readinessEnumMatches,
  readinessSlug,
  readinessSlugValue
} from "../../readiness/readinessUtils.js"
import type { Report } from "../../report/Report.js"
import { WireReserveTool } from "../../tools/wire/WireReserveTool.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../ClusterBuildStep.js"
import {
  runReadinessAssertion,
  type ReadinessCheckStepInput
} from "./ReadinessStepTools.js"

const {
  SysioChainsChainkind,
  SysioOpregOperatorstatus,
  SysioOpregOperatortype,
  SysioReservReservestatus,
  SysioUwritUnderwriterequeststatus
} = SysioContracts

interface SwapReadinessInput extends ReadinessCheckStepInput {
  readonly kind: "SwapReadinessSteps.Input"
}

interface ExternalAssetProbe {
  readonly label: string
  readonly native: boolean
  readonly address: string
  readonly deployed: boolean
  readonly error?: string
}

interface SolanaAccountInfoResponse {
  readonly value?: unknown
}

/** Swap-specific read-only Step factories composed by readiness PhaseGroups. */
export namespace SwapReadinessSteps {
  /** Validate the depot underwriting configuration. */
  export function planUnderwritingConfig(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ) {
    return plan(
      actor,
      name,
      description,
      options,
      ClusterReadinessCheckId["swap.underwriting-config"],
      ClusterReadinessReasonCode["configuration-incomplete"],
      runUnderwritingConfig
    )
  }

  /** Validate active underwriter collateral coverage. */
  export function planActiveUnderwriters(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ) {
    return plan(
      actor,
      name,
      description,
      options,
      ClusterReadinessCheckId["swap.active-underwriters"],
      ClusterReadinessReasonCode["liquidity-unavailable"],
      runActiveUnderwriters
    )
  }

  /** Validate deployed external assets backing public reserves. */
  export function planExternalAssets(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ) {
    return plan(
      actor,
      name,
      description,
      options,
      ClusterReadinessCheckId["swap.external-assets"],
      ClusterReadinessReasonCode["deployment-incomplete"],
      runExternalAssets
    )
  }

  /** Validate active token bindings for funded public reserves. */
  export function planAssetRegistry(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ) {
    return plan(
      actor,
      name,
      description,
      options,
      ClusterReadinessCheckId["swap.asset-registry"],
      ClusterReadinessReasonCode["asset-unavailable"],
      runAssetRegistry
    )
  }

  /** Validate funded public liquidity on every external chain. */
  export function planPublicReserves(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ) {
    return plan(
      actor,
      name,
      description,
      options,
      ClusterReadinessCheckId["swap.public-reserves"],
      ClusterReadinessReasonCode["liquidity-unavailable"],
      runPublicReserves
    )
  }

  /** Build every advertised public route from the live registry. */
  export function planRouteRegistry(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ) {
    return plan(
      actor,
      name,
      description,
      options,
      ClusterReadinessCheckId["swap.route-registry"],
      ClusterReadinessReasonCode["asset-unavailable"],
      runRouteRegistry
    )
  }

  /** Validate a positive canonical quote for every public direction. */
  export function planRouteQuotes(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ) {
    return plan(
      actor,
      name,
      description,
      options,
      ClusterReadinessCheckId["swap.route-quotes"],
      ClusterReadinessReasonCode["liquidity-unavailable"],
      runRouteQuotes
    )
  }

  /** Validate that no expired pending underwriting requests remain. */
  export function planRequestBacklog(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ) {
    return plan(
      actor,
      name,
      description,
      options,
      ClusterReadinessCheckId["swap.request-backlog"],
      ClusterReadinessReasonCode["protocol-unavailable"],
      runRequestBacklog
    )
  }
}

function plan(
  actor: Report.Actor,
  name: string,
  description: string,
  options: ClusterBuildStepOptions,
  id: ClusterReadinessCheckId,
  failureReason: ClusterReadinessReasonCode,
  runner: (
    context: ReadinessContext,
    input: SwapReadinessInput,
    signal: AbortSignal
  ) => Promise<void>
): ClusterBuildStep<ReadinessContext, SwapReadinessInput> {
  return ClusterBuildStep.create(
    actor,
    name,
    description,
    options,
    {
      kind: "SwapReadinessSteps.Input",
      id,
      area: ClusterReadinessArea.swap,
      blocking: true,
      failureReason
    },
    runner
  )
}

/** Run underwriting-configuration validation. */
export async function runUnderwritingConfig(
  context: ReadinessContext,
  input: SwapReadinessInput,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  await runReadinessAssertion(context, input, async () => {
    const config = await context.wireSystem.uwrit.tables.uwconfig.first(),
      invalidFields = [
        config.fee_bps < 0 || config.fee_bps > WireReserveTool.BpsTotal
          ? "fee_bps"
          : null,
        Number(config.collateral_lock_duration_ms) <= 0
          ? "collateral_lock_duration_ms"
          : null,
        Number(config.min_fromwire_amount) <= 0 ? "min_fromwire_amount" : null,
        config.fromwire_revert_fee_bps < 0 ||
        config.fromwire_revert_fee_bps > WireReserveTool.BpsTotal
          ? "fromwire_revert_fee_bps"
          : null
      ].filter((field): field is string => field != null)

    if (invalidFields.length > 0) {
      throw new ReadinessAssertionError(
        `Invalid sysio.uwrit::uwconfig fields: ${invalidFields.join(", ")}`,
        ClusterReadinessReasonCode["configuration-incomplete"],
        { invalidFields }
      )
    }
    return {
      detail:
        "Underwriting fees, lock duration, and WIRE-origin minimum are configured",
      evidence: {
        feeBps: config.fee_bps,
        collateralLockDurationMs: config.collateral_lock_duration_ms,
        minimumFromWireAmount: config.min_fromwire_amount,
        fromWireRevertFeeBps: config.fromwire_revert_fee_bps
      }
    }
  })
}

/** Run active-underwriter and collateral-matrix validation. */
export async function runActiveUnderwriters(
  context: ReadinessContext,
  input: SwapReadinessInput,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  await runReadinessAssertion(context, input, async () => {
    const [configResult, operatorsResult, chainsResult] = await Promise.all([
        readinessBoundedQuery(
          context.wireSystem.opreg.tables.opconfig.query({
            limit: ReadinessMaxTableRows
          }),
          "sysio.opreg::opconfig"
        ),
        readinessBoundedQuery(
          context.wireSystem.opreg.tables.operators.query({
            limit: ReadinessMaxTableRows
          }),
          "sysio.opreg::operators"
        ),
        readinessBoundedQuery(
          context.wireSystem.chains.tables.chains.query({
            limit: ReadinessMaxTableRows
          }),
          "sysio.chains::chains"
        )
      ]),
      config = configResult.rows[0]

    if (!config) throw new Error("sysio.opreg::opconfig is missing")

    const requirements = config.req_uw_collat,
      externalChains = chainsResult.rows.filter(
        row => row.active && isExternalChain(row)
      ),
      externalChainCodes = externalChains.map(row =>
        readinessSlugValue(row.code)
      ),
      missingRequirementCodes = externalChainCodes.filter(
        chainCode =>
          !requirements.some(
            requirement =>
              readinessSlugValue(requirement.chain_code) === chainCode
          )
      ),
      missingRequirementChains = externalChains
        .filter(row =>
          missingRequirementCodes.includes(readinessSlugValue(row.code))
        )
        .map(row => readinessSlug(row.code)),
      activeUnderwriters = operatorsResult.rows.filter(
        operator =>
          readinessEnumMatches(
            operator.type,
            SysioOpregOperatortype.OPERATOR_TYPE_UNDERWRITER,
            "OPERATOR_TYPE_UNDERWRITER"
          ) &&
          readinessEnumMatches(
            operator.status,
            SysioOpregOperatorstatus.OPERATOR_STATUS_ACTIVE,
            "OPERATOR_STATUS_ACTIVE"
          )
      ),
      collateralized = activeUnderwriters.filter(operator =>
        requirements.every(requirement => {
          const balance = operator.balances.find(
            candidate =>
              readinessSlugValue(candidate.chain_code) ===
                readinessSlugValue(requirement.chain_code) &&
              readinessSlugValue(candidate.token_code) ===
                readinessSlugValue(requirement.token_code)
          )
          return (
            balance != null &&
            BigInt(balance.balance) >= BigInt(requirement.min_bond)
          )
        })
      )

    if (
      requirements.length === 0 ||
      requirements.some(requirement => BigInt(requirement.min_bond) <= 0n) ||
      missingRequirementCodes.length > 0 ||
      config.max_available_underwriters <= 0
    ) {
      throw new ReadinessAssertionError(
        missingRequirementChains.length > 0
          ? `Underwriter collateral requirements are missing for ${missingRequirementChains.join(", ")}`
          : "The underwriter collateral matrix is empty, invalid, or disabled",
        ClusterReadinessReasonCode["configuration-incomplete"],
        {
          requirementCount: requirements.length,
          missingRequirementChainCodes: missingRequirementCodes,
          missingRequirementChains,
          maxAvailableUnderwriters: config.max_available_underwriters
        }
      )
    }
    if (collateralized.length === 0) {
      throw new ReadinessAssertionError(
        "No ACTIVE underwriter satisfies every configured collateral minimum",
        ClusterReadinessReasonCode["liquidity-unavailable"],
        {
          requiredCollateralEntries: requirements.length,
          activeUnderwriters: activeUnderwriters.map(
            operator => operator.account
          )
        }
      )
    }
    return {
      detail: `${collateralized.length} ACTIVE underwriter(s) satisfy the full collateral matrix`,
      evidence: {
        accounts: collateralized.map(operator => operator.account),
        requiredCollateralEntries: requirements.length
      }
    }
  })
}

/** Run live external token/mint deployment validation. */
export async function runExternalAssets(
  context: ReadinessContext,
  input: SwapReadinessInput,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  await runReadinessAssertion(context, input, async () => {
    const { chains, tokens, reserves } = await readReserveState(context),
      publicAssets = fundedPublicReserves(reserves),
      ethereum = context.endpoint(ClusterReadinessEndpointKind.ethereum),
      solana = context.endpoint(ClusterReadinessEndpointKind.solana),
      probes = await Promise.all(
        publicAssets.map(async (reserve): Promise<ExternalAssetProbe> => {
          const chain = chains.find(
              candidate =>
                candidate.active &&
                readinessSlugValue(candidate.code) ===
                  readinessSlugValue(reserve.chain_code)
            ),
            token = tokens.find(
              candidate =>
                candidate.active &&
                readinessSlugValue(candidate.chain_code) ===
                  readinessSlugValue(reserve.chain_code) &&
                readinessSlugValue(candidate.token_code) ===
                  readinessSlugValue(reserve.token_code)
            ),
            label = `${readinessSlug(reserve.chain_code)}/${readinessSlug(reserve.token_code)}`,
            address = token?.contract_addr.trim() ?? ""

          if (!chain || !token)
            return failedAsset(
              label,
              address,
              "active chain or token binding missing"
            )
          if (token.is_native)
            return { label, native: true, address: "native", deployed: true }
          if (!address)
            return failedAsset(label, address, "contract_addr is empty")

          if (
            readinessEnumMatches(
              chain.kind,
              SysioChainsChainkind.CHAIN_KIND_EVM,
              "CHAIN_KIND_EVM"
            )
          ) {
            if (!ethereum)
              return failedAsset(label, address, "EVM endpoint is missing")
            if (!/^(?:0x)?[0-9a-f]{40}$/i.test(address))
              return failedAsset(label, address, "invalid EVM contract address")
            const normalized = address.startsWith("0x")
              ? address
              : `0x${address}`
            try {
              const code = await context.jsonRpc<string>(
                ethereum.url,
                "eth_getCode",
                [normalized, "latest"]
              )
              return code === "0x"
                ? failedAsset(label, normalized, "no EVM bytecode is deployed")
                : { label, native: false, address: normalized, deployed: true }
            } catch (error) {
              return failedAsset(label, normalized, errorMessage(error))
            }
          }

          if (
            readinessEnumMatches(
              chain.kind,
              SysioChainsChainkind.CHAIN_KIND_SVM,
              "CHAIN_KIND_SVM"
            )
          ) {
            if (!solana)
              return failedAsset(label, address, "SVM endpoint is missing")
            const publicKey = solanaPublicKey(address)
            if (!publicKey)
              return failedAsset(label, address, "invalid Solana mint address")
            try {
              const account = await context.jsonRpc<SolanaAccountInfoResponse>(
                solana.url,
                "getAccountInfo",
                [publicKey, { encoding: "base64" }]
              )
              return account.value == null
                ? failedAsset(
                    label,
                    publicKey,
                    "Solana mint account is missing"
                  )
                : { label, native: false, address: publicKey, deployed: true }
            } catch (error) {
              return failedAsset(label, publicKey, errorMessage(error))
            }
          }

          return failedAsset(label, address, "unsupported external chain kind")
        })
      ),
      failures = probes.filter(probe => !probe.deployed)

    if (probes.length === 0 || failures.length > 0) {
      throw new ReadinessAssertionError(
        failures.length > 0
          ? `External asset deployment validation failed: ${failures.map(probe => `${probe.label}: ${probe.error}`).join("; ")}`
          : "No funded public reserve assets are available for deployment validation",
        ClusterReadinessReasonCode["deployment-incomplete"],
        { assets: probes }
      )
    }
    return {
      detail: `${probes.length} public reserve asset(s) resolve to native currency or a deployed token/mint`,
      evidence: { assets: probes }
    }
  })
}

/** Run funded-reserve token-binding validation. */
export async function runAssetRegistry(
  context: ReadinessContext,
  input: SwapReadinessInput,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  await runReadinessAssertion(context, input, async () => {
    const { tokens, reserves } = await readReserveState(context),
      funded = fundedPublicReserves(reserves),
      eligible = eligibleReserves(funded, tokens),
      unbound = funded.filter(reserve => !eligible.includes(reserve))
    if (funded.length === 0 || unbound.length > 0) {
      throw new ReadinessAssertionError(
        unbound.length > 0
          ? `${unbound.length} funded public reserve(s) lack an active chain-token binding`
          : "No funded public reserve assets are registered",
        ClusterReadinessReasonCode["asset-unavailable"],
        {
          unbound: unbound.map(
            reserve =>
              `${readinessSlug(reserve.chain_code)}/${readinessSlug(reserve.token_code)}/${readinessSlug(reserve.reserve_code)}`
          )
        }
      )
    }
    return {
      detail: `${eligible.length} funded public reserve asset(s) have active chain-token bindings`,
      evidence: { eligibleAssets: eligible.length }
    }
  })
}

/** Run public-reserve liquidity coverage validation. */
export async function runPublicReserves(
  context: ReadinessContext,
  input: SwapReadinessInput,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  await runReadinessAssertion(context, input, async () => {
    const { chains, tokens, reserves } = await readReserveState(context),
      externalChains = chains.filter(row => row.active && isExternalChain(row)),
      hasEthereum = externalChains.some(row =>
        readinessEnumMatches(
          row.kind,
          SysioChainsChainkind.CHAIN_KIND_EVM,
          "CHAIN_KIND_EVM"
        )
      ),
      hasSolana = externalChains.some(row =>
        readinessEnumMatches(
          row.kind,
          SysioChainsChainkind.CHAIN_KIND_SVM,
          "CHAIN_KIND_SVM"
        )
      ),
      publicActive = activePublicReserves(reserves),
      funded = fundedPublicReserves(reserves),
      eligible = eligibleReserves(funded, tokens),
      missing = externalChains
        .filter(
          chain =>
            !eligible.some(
              reserve =>
                readinessSlugValue(reserve.chain_code) ===
                readinessSlugValue(chain.code)
            )
        )
        .map(chain => readinessSlug(chain.code))

    if (!hasEthereum || !hasSolana || missing.length > 0) {
      throw new ReadinessAssertionError(
        missing.length > 0
          ? `No funded public reserve is available for ${missing.join(", ")}`
          : "Both active EVM and SVM chain rows are required for cross-chain swaps",
        ClusterReadinessReasonCode["liquidity-unavailable"],
        { missingChainLiquidity: missing }
      )
    }
    return {
      detail: `${eligible.length} funded public reserve(s) cover every active external chain`,
      evidence: {
        activePublic: publicActive.length,
        funded: funded.length,
        eligible: eligible.length
      }
    }
  })
}

/** Run public route construction validation. */
export async function runRouteRegistry(
  context: ReadinessContext,
  input: SwapReadinessInput,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  await runReadinessAssertion(context, input, async () => {
    const routes = await buildRoutes(context)
    context.recordRoutes(routes)
    if (routes.length === 0) {
      throw new ReadinessAssertionError(
        "No complete directional route set can be constructed from active chain-token and reserve rows",
        ClusterReadinessReasonCode["asset-unavailable"]
      )
    }
    return {
      detail: `${routes.length} directional public route(s) can be constructed from the live registry`,
      evidence: { routeCount: routes.length }
    }
  })
}

/** Run positive quote validation for every constructed direction. */
export async function runRouteQuotes(
  context: ReadinessContext,
  input: SwapReadinessInput,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  await runReadinessAssertion(context, input, async () => {
    const routes = context.outputs.get(ReadinessOutputs.routes) ?? [],
      failed = routes.filter(route => !route.preflightReady)
    if (routes.length === 0 || failed.length > 0) {
      throw new ReadinessAssertionError(
        routes.length === 0
          ? "No constructed route is available for quote validation"
          : `${failed.length} directional route(s) return a zero quote at the read-only probe size`,
        ClusterReadinessReasonCode["liquidity-unavailable"],
        {
          failedRoutes: failed.map(
            route => `${route.source} -> ${route.destination}`
          )
        }
      )
    }
    return {
      detail: `All ${routes.length} directional route(s) return a positive canonical depot quote`,
      evidence: {
        routeCount: routes.length,
        probeDepthDivisor: ReadinessConfig.QuoteProbeDepthDivisor.toString()
      }
    }
  })
}

/** Run expired underwriting-request backlog validation. */
export async function runRequestBacklog(
  context: ReadinessContext,
  input: SwapReadinessInput,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  await runReadinessAssertion(context, input, async () => {
    const [epochResult, requestsResult, queueResult] = await Promise.all([
        readinessBoundedQuery(
          context.wireSystem.epoch.tables.epochstate.query({
            limit: ReadinessMaxTableRows
          }),
          "sysio.epoch::epochstate"
        ),
        readinessBoundedQuery(
          context.wireSystem.uwrit.tables.uwreqs.query({
            limit: ReadinessMaxTableRows
          }),
          "sysio.uwrit::uwreqs"
        ),
        readinessBoundedQuery(
          context.wireSystem.uwrit.tables.fwqueue.query({
            limit: ReadinessMaxTableRows
          }),
          "sysio.uwrit::fwqueue"
        )
      ]),
      epoch = epochResult.rows[0]
    if (!epoch) throw new Error("sysio.epoch::epochstate is missing")

    const stale = requestsResult.rows.filter(
      request =>
        readinessEnumMatches(
          request.status,
          SysioUwritUnderwriterequeststatus.UNDERWRITE_REQUEST_STATUS_PENDING,
          "UNDERWRITE_REQUEST_STATUS_PENDING"
        ) && request.expires_at_epoch < epoch.current_epoch_index
    )
    if (stale.length > 0) {
      throw new ReadinessAssertionError(
        `${stale.length} expired PENDING underwriting request(s) remain`,
        ClusterReadinessReasonCode["protocol-unavailable"],
        {
          currentEpoch: epoch.current_epoch_index,
          staleRequestIds: stale.map(request => request.id),
          queueCount: queueResult.rows.length
        }
      )
    }
    return {
      detail:
        "No expired PENDING underwriting requests were found; the WIRE-origin queue was counted without inventing an expiry policy",
      evidence: {
        currentEpoch: epoch.current_epoch_index,
        requestCount: requestsResult.rows.length,
        queueCount: queueResult.rows.length
      }
    }
  })
}

async function readReserveState(context: ReadinessContext) {
  const [chains, tokens, reserves] = await Promise.all([
    readinessBoundedQuery(
      context.wireSystem.chains.tables.chains.query({
        limit: ReadinessMaxTableRows
      }),
      "sysio.chains::chains"
    ),
    readinessBoundedQuery(
      context.wireSystem.tokens.tables.chaintokens.query({
        limit: ReadinessMaxTableRows
      }),
      "sysio.tokens::chaintokens"
    ),
    readinessBoundedQuery(
      context.wireSystem.reserv.tables.reserves.query({
        limit: ReadinessMaxTableRows
      }),
      "sysio.reserv::reserves"
    )
  ])
  return { chains: chains.rows, tokens: tokens.rows, reserves: reserves.rows }
}

function isExternalChain(row: SysioContracts.SysioChainsChainRowType): boolean {
  return (
    readinessEnumMatches(
      row.kind,
      SysioChainsChainkind.CHAIN_KIND_EVM,
      "CHAIN_KIND_EVM"
    ) ||
    readinessEnumMatches(
      row.kind,
      SysioChainsChainkind.CHAIN_KIND_SVM,
      "CHAIN_KIND_SVM"
    )
  )
}

function activePublicReserves(
  reserves: SysioContracts.SysioReservReserveRowType[]
) {
  return reserves.filter(
    reserve =>
      !reserve.is_private &&
      readinessEnumMatches(
        reserve.status,
        SysioReservReservestatus.RESERVE_STATUS_ACTIVE,
        "RESERVE_STATUS_ACTIVE"
      )
  )
}

function fundedPublicReserves(
  reserves: SysioContracts.SysioReservReserveRowType[]
) {
  return activePublicReserves(reserves).filter(
    reserve =>
      BigInt(reserve.reserve_chain_amount) > 0n &&
      BigInt(reserve.reserve_wire_amount) > 0n
  )
}

function eligibleReserves(
  reserves: SysioContracts.SysioReservReserveRowType[],
  tokens: SysioContracts.SysioTokensChainTokenRowType[]
) {
  return reserves.filter(reserve =>
    tokens.some(
      token =>
        token.active &&
        readinessSlugValue(token.chain_code) ===
          readinessSlugValue(reserve.chain_code) &&
        readinessSlugValue(token.token_code) ===
          readinessSlugValue(reserve.token_code)
    )
  )
}

async function buildRoutes(
  context: ReadinessContext
): Promise<ClusterSwapRouteReadiness[]> {
  const { chains, tokens, reserves } = await readReserveState(context),
    eligible = eligibleReserves(fundedPublicReserves(reserves), tokens),
    label = (reserve: SysioContracts.SysioReservReserveRowType) => {
      const chain = chains.find(
        candidate =>
          readinessSlugValue(candidate.code) ===
          readinessSlugValue(reserve.chain_code)
      )
      return `${readinessSlug(reserve.token_code)} on ${chain?.name ?? readinessSlug(reserve.chain_code)}`
    },
    routes: ClusterSwapRouteReadiness[] = []

  for (const reserve of eligible) {
    const external = label(reserve),
      chainDepth = BigInt(reserve.reserve_chain_amount),
      wireDepth = BigInt(reserve.reserve_wire_amount),
      chainProbe = probeAmount(
        chainDepth,
        ReadinessConfig.QuoteProbeDepthDivisor
      ),
      wireProbe = probeAmount(
        wireDepth,
        ReadinessConfig.QuoteProbeDepthDivisor
      ),
      toWireQuote = WireReserveTool.cpOutput(chainDepth, wireDepth, chainProbe),
      fromWireQuote = WireReserveTool.cpOutput(wireDepth, chainDepth, wireProbe)
    routes.push(
      route(external, "WIRE", chainProbe, toWireQuote),
      route("WIRE", external, wireProbe, fromWireQuote)
    )
  }

  for (const source of eligible) {
    for (const destination of eligible) {
      if (
        readinessSlugValue(source.chain_code) ===
        readinessSlugValue(destination.chain_code)
      )
        continue
      const sourceProbe = probeAmount(
          BigInt(source.reserve_chain_amount),
          ReadinessConfig.QuoteProbeDepthDivisor
        ),
        wireIntermediate = WireReserveTool.cpOutput(
          BigInt(source.reserve_chain_amount),
          BigInt(source.reserve_wire_amount),
          sourceProbe
        ),
        target = WireReserveTool.cpOutput(
          BigInt(destination.reserve_wire_amount),
          BigInt(destination.reserve_chain_amount),
          wireIntermediate
        )
      routes.push(route(label(source), label(destination), sourceProbe, target))
    }
  }
  return routes
}

function route(
  source: string,
  destination: string,
  sourceAmount: bigint,
  destinationAmount: bigint
): ClusterSwapRouteReadiness {
  return {
    source,
    destination,
    preflightReady: destinationAmount > 0n,
    quotedSourceAmount: sourceAmount.toString(),
    quotedDestinationAmount: destinationAmount.toString(),
    transactionallyVerified: false,
    detail:
      "Live registry and depot depth quote positively; external custody, daemon circulation, and settlement require a canary"
  }
}

function probeAmount(depth: bigint, divisor: bigint): bigint {
  const scaled = depth / divisor
  return scaled > 0n ? scaled : 1n
}

function failedAsset(
  label: string,
  address: string,
  error: string
): ExternalAssetProbe {
  return { label, native: false, address, deployed: false, error }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function solanaPublicKey(address: string): string {
  try {
    if (/^[0-9a-f]{64}$/i.test(address))
      return Base58.encode(Buffer.from(address, "hex"))
    Base58.decode(address)
    return address
  } catch {
    return ""
  }
}
