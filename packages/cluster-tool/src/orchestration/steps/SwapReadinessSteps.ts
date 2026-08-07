import { Base58, SysioContracts } from "@wireio/sdk-core"
import { getLogger } from "@wireio/shared"
import {
  ClusterReadinessArea,
  ClusterReadinessCheckId,
  ClusterReadinessEndpointKind,
  ClusterReadinessReasonCode,
  type ClusterSwapRouteReadiness
} from "@wireio/cluster-tool-shared"

import {
  ExternalReserveCustodyReader,
  type SolanaAccountInfoResponse
} from "../../readiness/ExternalReserveCustodyReader.js"
import {
  ReadinessAssertionError,
  ReadinessContext
} from "../../readiness/ReadinessContext.js"
import { ReadinessConfig } from "../../readiness/ReadinessConfig.js"
import { ReadinessOutputs } from "../../readiness/ReadinessOutputs.js"
import {
  ReadinessMaxTableRows,
  readinessBoundedQuery,
  readinessErrorMessage,
  readinessEnumMatches,
  readinessReserveLabel,
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

const log = getLogger(__filename),
  EthereumRpcMethod = { getCode: "eth_getCode" } as const,
  EthereumBlockTag = { latest: "latest" } as const,
  SolanaRpcMethod = { getAccountInfo: "getAccountInfo" } as const,
  SolanaEncoding = { base64: "base64" } as const,
  {
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

type CollateralBucketRow =
  | SysioContracts.SysioOpregBalanceEntryType
  | SysioContracts.SysioUwritLockEntryType
  | SysioContracts.SysioOpregWithdrawRequestType

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

  /** Validate external reserve mirrors, token mappings, precision, and custody. */
  export function planExternalCustody(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    blocking: boolean
  ) {
    return plan(
      actor,
      name,
      description,
      options,
      ClusterReadinessCheckId["swap.external-custody"],
      ClusterReadinessReasonCode["configuration-incomplete"],
      runExternalCustody,
      blocking
    )
  }

  /** Validate active token bindings for advertised public reserves. */
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

  /** Validate positive liquidity for every advertised public reserve. */
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
  ) => Promise<void>,
  blocking = true
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
      blocking,
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
    const [
        configResult,
        operatorsResult,
        chainsResult,
        chainTokensResult,
        reservesResult,
        locksResult,
        withdrawalsResult
      ] = await Promise.all([
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
        ),
        readinessBoundedQuery(
          context.wireSystem.uwrit.tables.locks.query({
            limit: ReadinessMaxTableRows
          }),
          "sysio.uwrit::locks"
        ),
        readinessBoundedQuery(
          context.wireSystem.opreg.tables.wtdwqueue.query({
            limit: ReadinessMaxTableRows
          }),
          "sysio.opreg::wtdwqueue"
        )
      ]),
      config = configResult.rows[0]

    if (!config) throw new Error("sysio.opreg::opconfig is missing")

    const requirements = config.req_uw_collat,
      externalChains = chainsResult.rows.filter(
        row => row.active && isExternalChain(row)
      ),
      advertisedReserves = eligibleReserves(
        activePublicReserves(reservesResult.rows).filter(reserve =>
          externalChains.some(
            chain =>
              readinessSlugValue(chain.code) ===
              readinessSlugValue(reserve.chain_code)
          )
        ),
        chainTokensResult.rows
      ),
      advertisedBuckets = advertisedReserves.filter(
        (reserve, index, all) =>
          all.findIndex(
            candidate =>
              collateralBucketKey(candidate) === collateralBucketKey(reserve)
          ) === index
      ),
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
      buckets = advertisedBuckets.map(reserve => {
        const requirement = requirements.find(
            candidate =>
              readinessSlugValue(candidate.chain_code) ===
                readinessSlugValue(reserve.chain_code) &&
              readinessSlugValue(candidate.token_code) ===
                readinessSlugValue(reserve.token_code)
          ),
          minimum = requirement ? BigInt(requirement.min_bond) : 0n,
          accounts =
            minimum > 0n
              ? activeUnderwriters
                  .filter(
                    operator =>
                      availableCollateral(
                        operator,
                        reserve,
                        locksResult.rows,
                        withdrawalsResult.rows
                      ) >= minimum
                  )
                  .map(operator => operator.account)
              : [],
          issues = [
            !requirement ? "collateral requirement is missing" : null,
            requirement && minimum <= 0n
              ? "collateral requirement is not positive"
              : null,
            requirement && minimum > 0n && accounts.length === 0
              ? "no ACTIVE underwriter has sufficient available collateral"
              : null
          ].filter((issue): issue is string => issue != null)
        return {
          chainCode: readinessSlugValue(reserve.chain_code),
          tokenCode: readinessSlugValue(reserve.token_code),
          label: `${readinessSlug(reserve.chain_code)}/${readinessSlug(reserve.token_code)}`,
          minimum: minimum.toString(),
          accounts,
          ready: issues.length === 0,
          issues
        }
      }),
      fullCoverageAccounts = activeUnderwriters
        .map(operator => operator.account)
        .filter(account =>
          buckets.every(bucket => bucket.accounts.includes(account))
        ),
      configurationFailures = buckets.filter(bucket =>
        bucket.issues.some(issue => issue.includes("requirement"))
      )

    context.outputs.set(ReadinessOutputs.collateralBuckets, buckets)

    if (
      advertisedBuckets.length === 0 ||
      configurationFailures.length > 0 ||
      config.max_available_underwriters <= 0
    ) {
      throw new ReadinessAssertionError(
        configurationFailures.length > 0
          ? `Underwriter collateral requirements are incomplete for ${configurationFailures.map(bucket => bucket.label).join(", ")}`
          : "The advertised collateral matrix is empty or underwriting is disabled",
        ClusterReadinessReasonCode["configuration-incomplete"],
        {
          advertisedBuckets: buckets,
          maxAvailableUnderwriters: config.max_available_underwriters
        }
      )
    }
    if (fullCoverageAccounts.length === 0) {
      throw new ReadinessAssertionError(
        "No ACTIVE underwriter has sufficient available collateral for every advertised token bucket",
        ClusterReadinessReasonCode["liquidity-unavailable"],
        {
          advertisedBuckets: buckets,
          activeUnderwriters: activeUnderwriters.map(
            operator => operator.account
          ),
          activeLocks: locksResult.rows.length,
          pendingWithdrawals: withdrawalsResult.rows.length
        }
      )
    }
    return {
      detail: `${fullCoverageAccounts.length} ACTIVE underwriter(s) can serve every advertised token bucket after locks and pending withdrawals`,
      evidence: {
        accounts: fullCoverageAccounts,
        advertisedBuckets: buckets,
        activeLocks: locksResult.rows.length,
        pendingWithdrawals: withdrawalsResult.rows.length
      }
    }
  })
}

/** Run external reserve-mirror and custody-funding validation. */
export async function runExternalCustody(
  context: ReadinessContext,
  input: SwapReadinessInput,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  await runReadinessAssertion(context, input, async () => {
    const state = await readReserveState(context),
      advertised = eligibleReserves(
        activePublicReserves(state.reserves),
        state.chainTokens
      ),
      probes = await ExternalReserveCustodyReader.read(context, {
        ...state,
        reserves: advertised
      }),
      configurationFailures = probes.filter(probe => !probe.configured),
      fundingFailures = probes.filter(
        probe => probe.configured && !probe.funded
      )

    context.outputs.set(ReadinessOutputs.externalCustodyReserves, probes)
    if (probes.length === 0 || configurationFailures.length > 0) {
      throw new ReadinessAssertionError(
        configurationFailures.length > 0
          ? `External custody configuration failed for ${configurationFailures.map(probe => probe.label).join(", ")}`
          : "No advertised public reserve is available for external custody validation",
        ClusterReadinessReasonCode["configuration-incomplete"],
        { reserves: probes }
      )
    }
    if (fundingFailures.length > 0) {
      throw new ReadinessAssertionError(
        `External custody is unfunded for ${fundingFailures.map(probe => probe.label).join(", ")}`,
        ClusterReadinessReasonCode["liquidity-unavailable"],
        { reserves: probes }
      )
    }
    return {
      detail: `${probes.length} advertised public reserve(s) have aligned, funded external custody`,
      evidence: { reserves: probes }
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
    const { chains, chainTokens, reserves } = await readReserveState(context),
      publicAssets = activePublicReserves(reserves),
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
            token = chainTokens.find(
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
                EthereumRpcMethod.getCode,
                [normalized, EthereumBlockTag.latest]
              )
              return code === "0x"
                ? failedAsset(label, normalized, "no EVM bytecode is deployed")
                : { label, native: false, address: normalized, deployed: true }
            } catch (error) {
              const message = readinessErrorMessage(error)
              log.warn(
                `Ethereum asset deployment probe failed for ${label}: ${message}`
              )
              return failedAsset(label, normalized, message)
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
                SolanaRpcMethod.getAccountInfo,
                [publicKey, { encoding: SolanaEncoding.base64 }]
              )
              return account.value == null
                ? failedAsset(
                    label,
                    publicKey,
                    "Solana mint account is missing"
                  )
                : { label, native: false, address: publicKey, deployed: true }
            } catch (error) {
              const message = readinessErrorMessage(error)
              log.warn(
                `Solana asset deployment probe failed for ${label}: ${message}`
              )
              return failedAsset(label, publicKey, message)
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
          : "No advertised public reserve assets are available for deployment validation",
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

/** Run advertised-reserve token-binding validation. */
export async function runAssetRegistry(
  context: ReadinessContext,
  input: SwapReadinessInput,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  await runReadinessAssertion(context, input, async () => {
    const { chainTokens, reserves } = await readReserveState(context),
      advertised = activePublicReserves(reserves),
      eligible = eligibleReserves(advertised, chainTokens),
      unbound = advertised.filter(reserve => !eligible.includes(reserve))
    if (advertised.length === 0 || unbound.length > 0) {
      throw new ReadinessAssertionError(
        unbound.length > 0
          ? `${unbound.length} advertised public reserve(s) lack an active chain-token binding`
          : "No advertised public reserve assets are registered",
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
      detail: `${eligible.length} advertised public reserve asset(s) have active chain-token bindings`,
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
    const { chains, chainTokens, reserves } = await readReserveState(context),
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
      eligible = eligibleReserves(publicActive, chainTokens),
      zeroDepth = publicActive.filter(
        reserve =>
          BigInt(reserve.reserve_chain_amount) <= 0n ||
          BigInt(reserve.reserve_wire_amount) <= 0n
      ),
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

    if (
      !hasEthereum ||
      !hasSolana ||
      publicActive.length === 0 ||
      missing.length > 0 ||
      zeroDepth.length > 0
    ) {
      throw new ReadinessAssertionError(
        !hasEthereum || !hasSolana
          ? "Both active EVM and SVM chain rows are required for cross-chain swaps"
          : publicActive.length === 0
            ? "No advertised public reserve is registered"
            : missing.length > 0
              ? `No advertised public reserve is available for ${missing.join(", ")}`
              : `Advertised public reserves have zero liquidity: ${zeroDepth.map(readinessReserveLabel).join(", ")}`,
        ClusterReadinessReasonCode["liquidity-unavailable"],
        {
          missingChainLiquidity: missing,
          zeroDepthReserves: zeroDepth.map(readinessReserveLabel)
        }
      )
    }
    return {
      detail: `${eligible.length} advertised public reserve(s) have positive depot depth and cover every active external chain`,
      evidence: {
        activePublic: publicActive.length,
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
          : `${failed.length} directional route(s) fail infrastructure preflight or return a zero quote`,
        ClusterReadinessReasonCode["liquidity-unavailable"],
        {
          failedRoutes: failed.map(route => ({
            route: `${route.source} -> ${route.destination}`,
            detail: route.detail
          }))
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
  const [chains, chainTokens, tokens, reserves] = await Promise.all([
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
      context.wireSystem.tokens.tables.tokens.query({
        limit: ReadinessMaxTableRows
      }),
      "sysio.tokens::tokens"
    ),
    readinessBoundedQuery(
      context.wireSystem.reserv.tables.reserves.query({
        limit: ReadinessMaxTableRows
      }),
      "sysio.reserv::reserves"
    )
  ])
  return {
    chains: chains.rows,
    chainTokens: chainTokens.rows,
    tokens: tokens.rows,
    reserves: reserves.rows
  }
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

function collateralBucketKey(
  reserve: SysioContracts.SysioReservReserveRowType
): string {
  return `${readinessSlugValue(reserve.chain_code)}/${readinessSlugValue(reserve.token_code)}`
}

function availableCollateral(
  operator: SysioContracts.SysioOpregOperatorEntryType,
  reserve: SysioContracts.SysioReservReserveRowType,
  locks: SysioContracts.SysioUwritLockEntryType[],
  withdrawals: SysioContracts.SysioOpregWithdrawRequestType[]
): bigint {
  const matchesBucket = (candidate: CollateralBucketRow) =>
      readinessSlugValue(candidate.chain_code) ===
        readinessSlugValue(reserve.chain_code) &&
      readinessSlugValue(candidate.token_code) ===
        readinessSlugValue(reserve.token_code),
    balance = operator.balances.find(matchesBucket),
    locked = locks
      .filter(
        lock => lock.underwriter === operator.account && matchesBucket(lock)
      )
      .reduce((total, lock) => total + BigInt(lock.amount), 0n),
    pending = withdrawals
      .filter(
        withdrawal =>
          withdrawal.account === operator.account && matchesBucket(withdrawal)
      )
      .reduce((total, withdrawal) => total + BigInt(withdrawal.amount), 0n),
    raw = BigInt(balance?.balance ?? 0),
    reserved = locked + pending
  return raw > reserved ? raw - reserved : 0n
}

async function buildRoutes(
  context: ReadinessContext
): Promise<ClusterSwapRouteReadiness[]> {
  const { chains, chainTokens, reserves } = await readReserveState(context),
    eligible = eligibleReserves(activePublicReserves(reserves), chainTokens),
    label = (reserve: SysioContracts.SysioReservReserveRowType) => {
      const chain = chains.find(
        candidate =>
          readinessSlugValue(candidate.code) ===
          readinessSlugValue(reserve.chain_code)
      )
      return `${readinessSlug(reserve.token_code)} on ${chain?.name ?? readinessSlug(reserve.chain_code)}`
    },
    direct = eligible.flatMap(reserve => {
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
        toWireQuote = WireReserveTool.cpOutput(
          chainDepth,
          wireDepth,
          chainProbe
        ),
        fromWireQuote = WireReserveTool.cpOutput(
          wireDepth,
          chainDepth,
          wireProbe
        )
      return [
        route(context, external, "WIRE", chainProbe, toWireQuote, [reserve]),
        route(context, "WIRE", external, wireProbe, fromWireQuote, [reserve])
      ]
    }),
    crossChain = eligible.flatMap(source =>
      eligible
        .filter(
          destination =>
            readinessSlugValue(source.chain_code) !==
            readinessSlugValue(destination.chain_code)
        )
        .map(destination => {
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
          return route(
            context,
            label(source),
            label(destination),
            sourceProbe,
            target,
            [source, destination]
          )
        })
    )
  return [...direct, ...crossChain]
}

function route(
  context: ReadinessContext,
  source: string,
  destination: string,
  sourceAmount: bigint,
  destinationAmount: bigint,
  reserves: SysioContracts.SysioReservReserveRowType[]
): ClusterSwapRouteReadiness {
  const custody = context.outputs.assert(
      ReadinessOutputs.externalCustodyReserves
    ),
    buckets = context.outputs.assert(ReadinessOutputs.collateralBuckets),
    custodyIssues = reserves.flatMap(reserve => {
      const evidence = custody.find(
        candidate =>
          candidate.chainCode === readinessSlugValue(reserve.chain_code) &&
          candidate.tokenCode === readinessSlugValue(reserve.token_code) &&
          candidate.reserveCode === readinessSlugValue(reserve.reserve_code)
      )
      return evidence?.ready
        ? []
        : [
            evidence
              ? `${evidence.label}: ${evidence.issues.join(", ")}`
              : `${readinessReserveLabel(reserve)}: custody evidence is unavailable`
          ]
    }),
    routeBuckets = reserves.map(reserve =>
      buckets.find(
        candidate =>
          candidate.chainCode === readinessSlugValue(reserve.chain_code) &&
          candidate.tokenCode === readinessSlugValue(reserve.token_code)
      )
    ),
    commonUnderwriters = routeBuckets.reduce<string[]>(
      (accounts, bucket, index) =>
        index === 0
          ? (bucket?.accounts ?? [])
          : accounts.filter(account => bucket?.accounts.includes(account)),
      []
    ),
    collateralIssues = [
      ...routeBuckets.flatMap((bucket, index) =>
        bucket
          ? bucket.ready
            ? []
            : [`${bucket.label}: ${bucket.issues.join(", ")}`]
          : [
              `${readinessReserveLabel(reserves[index])}: collateral evidence is unavailable`
            ]
      ),
      routeBuckets.length > 1 && commonUnderwriters.length === 0
        ? "no single ACTIVE underwriter can cover both route legs"
        : null
    ].filter((issue): issue is string => issue != null),
    quoteIssues =
      destinationAmount > 0n ? [] : ["canonical depot quote returned zero"],
    issues = [...custodyIssues, ...collateralIssues, ...quoteIssues]
  return {
    source,
    destination,
    preflightReady: issues.length === 0,
    quotedSourceAmount: sourceAmount.toString(),
    quotedDestinationAmount: destinationAmount.toString(),
    transactionallyVerified: false,
    detail:
      issues.length === 0
        ? "Registry, depot quote, external custody, and available underwriter collateral pass; daemon circulation and settlement require a canary"
        : `Blocked: ${issues.join("; ")}`
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
