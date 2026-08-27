import { Base58, SysioContracts } from "@wireio/sdk-core"

import {
  ReadinessAssertionError,
  type ReadinessCapable,
  runReadinessAssertion
} from "../../readiness/ReadinessContext.js"
import { ReadinessConfig } from "../../readiness/ReadinessConfig.js"
import {
  type ReadinessCollateralBucket,
  ReadinessOutputs,
  type ReadinessRoute
} from "../../readiness/ReadinessOutputs.js"
import {
  ReadinessMaxTableRows,
  readinessBoundedQuery,
  readinessEnumMatches,
  readinessReserveLabel,
  readinessSlug,
  readinessSlugValue
} from "../../readiness/readinessUtils.js"
import type { Report } from "../../report/Report.js"
import { WireReserveTool } from "../../tools/wire/WireReserveTool.js"
import type { OrchestrationContext } from "../OrchestrationContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../ClusterBuildStep.js"
import type { StepInput } from "../StepRunner.js"

const {
    SysioChainsChainkind,
    SysioOpregOperatorstatus,
    SysioOpregOperatortype,
    SysioReservReservestatus,
    SysioUwritUnderwriterequeststatus
  } = SysioContracts,
  BpsTotal = 10_000

interface SwapReadinessInput extends StepInput {
  readonly kind: "SwapReadinessSteps.Input"
}

interface ExternalAssetProbe {
  readonly label: string
  readonly native: boolean
  readonly address: string
  readonly deployed: boolean
  readonly issue?: string
}

interface SolanaAccountInfoResponse {
  value: unknown | null
}

interface BoundedQueryResult {
  more: boolean
}

type CollateralBucketRow =
  | SysioContracts.SysioOpregBalanceEntryType
  | SysioContracts.SysioUwritLockEntryType
  | SysioContracts.SysioOpregWithdrawRequestType

type ReadinessContext = OrchestrationContext & ReadinessCapable
type ReadinessRunner<C extends ReadinessContext> = (
  context: C,
  input: SwapReadinessInput,
  signal: AbortSignal
) => Promise<void>

/** Swap-specific read-only Step factories shared by CLI and FlowScenario runs. */
export namespace SwapReadinessSteps {
  /** Validate underwriting configuration. */
  export function planUnderwritingConfig<C extends ReadinessContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, SwapReadinessInput> {
    return plan(actor, name, description, options, runUnderwritingConfig)
  }

  /** Validate active underwriter collateral coverage. */
  export function planActiveUnderwriters<C extends ReadinessContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, SwapReadinessInput> {
    return plan(actor, name, description, options, runActiveUnderwriters)
  }

  /** Validate external assets referenced by public reserves. */
  export function planExternalAssets<C extends ReadinessContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, SwapReadinessInput> {
    return plan(actor, name, description, options, runExternalAssets)
  }

  /** Validate active token bindings for public reserves. */
  export function planAssetRegistry<C extends ReadinessContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, SwapReadinessInput> {
    return plan(actor, name, description, options, runAssetRegistry)
  }

  /** Validate positive liquidity on every advertised public reserve. */
  export function planPublicReserves<C extends ReadinessContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, SwapReadinessInput> {
    return plan(actor, name, description, options, runPublicReserves)
  }

  /** Validate that expired pending underwriting requests are absent. */
  export function planRequestBacklog<C extends ReadinessContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, SwapReadinessInput> {
    return plan(actor, name, description, options, runRequestBacklog)
  }

  /** Build every public directional route from live registry state. */
  export function planRouteRegistry<C extends ReadinessContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, SwapReadinessInput> {
    return plan(actor, name, description, options, runRouteRegistry)
  }

  /** Require a positive canonical quote for every constructed route. */
  export function planRouteQuotes<C extends ReadinessContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, SwapReadinessInput> {
    return plan(actor, name, description, options, runRouteQuotes)
  }
}

function plan<C extends ReadinessContext>(
  actor: Report.Actor,
  name: string,
  description: string,
  options: ClusterBuildStepOptions,
  runner: ReadinessRunner<C>
): ClusterBuildStep<C, SwapReadinessInput> {
  return ClusterBuildStep.create(
    actor,
    name,
    description,
    options,
    { kind: "SwapReadinessSteps.Input" },
    runner
  )
}

/** Validate the live underwriting limits and fee bounds. */
export async function runUnderwritingConfig<C extends ReadinessContext>(
  context: C,
  _input: SwapReadinessInput,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  await runReadinessAssertion(context, async () => {
    const config =
        await context.readiness.wireSystem.uwrit.tables.uwconfig.first(),
      invalidFields = [
        config.fee_bps < 0 || config.fee_bps > BpsTotal ? "fee_bps" : null,
        Number(config.collateral_lock_duration_ms) <= 0
          ? "collateral_lock_duration_ms"
          : null,
        Number(config.min_fromwire_amount) <= 0 ? "min_fromwire_amount" : null,
        config.fromwire_revert_fee_bps < 0 ||
        config.fromwire_revert_fee_bps > BpsTotal
          ? "fromwire_revert_fee_bps"
          : null
      ].filter((field): field is string => field != null)
    if (invalidFields.length > 0) {
      throw new ReadinessAssertionError(
        `Invalid sysio.uwrit::uwconfig fields: ${invalidFields.join(", ")}`,
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

/** Validate one active underwriter can cover the advertised collateral matrix. */
export async function runActiveUnderwriters<C extends ReadinessContext>(
  context: C,
  _input: SwapReadinessInput,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  await runReadinessAssertion(context, async () => {
    const [
        configResult,
        operatorsResult,
        chainsResult,
        chainTokensResult,
        reservesResult,
        locksResult,
        withdrawalsResult
      ] = await Promise.all([
        bounded(
          context.readiness.wireSystem.opreg.tables.opconfig.query({
            limit: ReadinessMaxTableRows
          }),
          "sysio.opreg::opconfig"
        ),
        bounded(
          context.readiness.wireSystem.opreg.tables.operators.query({
            limit: ReadinessMaxTableRows
          }),
          "sysio.opreg::operators"
        ),
        bounded(
          context.readiness.wireSystem.chains.tables.chains.query({
            limit: ReadinessMaxTableRows
          }),
          "sysio.chains::chains"
        ),
        bounded(
          context.readiness.wireSystem.tokens.tables.chaintokens.query({
            limit: ReadinessMaxTableRows
          }),
          "sysio.tokens::chaintokens"
        ),
        bounded(
          context.readiness.wireSystem.reserv.tables.reserves.query({
            limit: ReadinessMaxTableRows
          }),
          "sysio.reserv::reserves"
        ),
        bounded(
          context.readiness.wireSystem.uwrit.tables.locks.query({
            limit: ReadinessMaxTableRows
          }),
          "sysio.uwrit::locks"
        ),
        bounded(
          context.readiness.wireSystem.opreg.tables.wtdwqueue.query({
            limit: ReadinessMaxTableRows
          }),
          "sysio.opreg::wtdwqueue"
        )
      ]),
      config = configResult.rows[0]
    if (config == null) throw new Error("sysio.opreg::opconfig is missing")

    const externalChains = chainsResult.rows.filter(
        row => row.active && isExternalChain(row)
      ),
      advertised = eligibleReserves(
        activePublicReserves(reservesResult.rows).filter(reserve =>
          externalChains.some(
            chain =>
              readinessSlugValue(chain.code) ===
              readinessSlugValue(reserve.chain_code)
          )
        ),
        chainTokensResult.rows
      ),
      bucketReserves = advertised.filter(
        (reserve, index, all) =>
          all.findIndex(
            candidate =>
              collateralBucketKey(candidate) === collateralBucketKey(reserve)
          ) === index
      ),
      underwriters = operatorsResult.rows.filter(
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
      buckets: ReadinessCollateralBucket[] = bucketReserves.map(reserve => {
        const requirement = config.req_uw_collat.find(
            candidate =>
              readinessSlugValue(candidate.chain_code) ===
                readinessSlugValue(reserve.chain_code) &&
              readinessSlugValue(candidate.token_code) ===
                readinessSlugValue(reserve.token_code)
          ),
          minimum = requirement ? BigInt(requirement.min_bond) : 0n,
          accounts =
            minimum > 0n
              ? underwriters
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
            requirement == null ? "collateral requirement is missing" : null,
            requirement != null && minimum <= 0n
              ? "collateral requirement is not positive"
              : null,
            requirement != null && minimum > 0n && accounts.length === 0
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
      fullCoverageAccounts = underwriters
        .map(operator => operator.account)
        .filter(account =>
          buckets.every(bucket => bucket.accounts.includes(account))
        ),
      invalidBuckets = buckets.filter(bucket => !bucket.ready)

    context.outputs.set(ReadinessOutputs.collateralBuckets, buckets)
    if (
      buckets.length === 0 ||
      config.max_available_underwriters <= 0 ||
      invalidBuckets.length > 0 ||
      fullCoverageAccounts.length === 0
    ) {
      throw new ReadinessAssertionError(
        buckets.length === 0
          ? "The advertised collateral matrix is empty"
          : invalidBuckets.length > 0
            ? `Collateral coverage is incomplete for ${invalidBuckets.map(bucket => bucket.label).join(", ")}`
            : "No ACTIVE underwriter can cover every advertised collateral bucket",
        {
          buckets,
          maxAvailableUnderwriters: config.max_available_underwriters,
          activeUnderwriters: underwriters.map(operator => operator.account)
        }
      )
    }
    return {
      detail: `${fullCoverageAccounts.length} ACTIVE underwriter(s) can cover every advertised collateral bucket`,
      evidence: {
        accounts: fullCoverageAccounts,
        buckets,
        activeLocks: locksResult.rows.length,
        pendingWithdrawals: withdrawalsResult.rows.length
      }
    }
  })
}

/** Validate native assets and deployed EVM contracts or Solana mint accounts. */
export async function runExternalAssets<C extends ReadinessContext>(
  context: C,
  _input: SwapReadinessInput,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  await runReadinessAssertion(context, async () => {
    const { chains, chainTokens, reserves } = await readReserveState(context),
      probes = await Promise.all(
        activePublicReserves(reserves).map(async reserve => {
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
          if (chain == null || token == null)
            return failedAsset(
              label,
              address,
              "active chain or token binding missing"
            )
          if (token.is_native)
            return { label, native: true, address: "native", deployed: true }
          if (address.length === 0)
            return failedAsset(label, address, "contract_addr is empty")
          if (
            readinessEnumMatches(
              chain.kind,
              SysioChainsChainkind.CHAIN_KIND_EVM,
              "CHAIN_KIND_EVM"
            )
          ) {
            if (!/^(?:0x)?[0-9a-f]{40}$/i.test(address))
              return failedAsset(label, address, "invalid EVM contract address")
            const normalized = address.startsWith("0x")
                ? address
                : `0x${address}`,
              code = await context.readiness.jsonRpc<string>(
                context.readiness.config.endpoints.ethereumRpc,
                "eth_getCode",
                [normalized, "latest"]
              )
            return code === "0x"
              ? failedAsset(label, normalized, "no EVM bytecode is deployed")
              : { label, native: false, address: normalized, deployed: true }
          }
          if (
            readinessEnumMatches(
              chain.kind,
              SysioChainsChainkind.CHAIN_KIND_SVM,
              "CHAIN_KIND_SVM"
            )
          ) {
            const publicKey = solanaPublicKey(address)
            if (publicKey.length === 0)
              return failedAsset(label, address, "invalid Solana mint address")
            const account =
              await context.readiness.jsonRpc<SolanaAccountInfoResponse>(
                context.readiness.config.endpoints.solanaRpc,
                "getAccountInfo",
                [publicKey, { encoding: "base64" }]
              )
            return account.value == null
              ? failedAsset(label, publicKey, "Solana mint account is missing")
              : { label, native: false, address: publicKey, deployed: true }
          }
          return failedAsset(label, address, "unsupported external chain kind")
        })
      ),
      failures = probes.filter(probe => !probe.deployed)
    if (probes.length === 0 || failures.length > 0) {
      throw new ReadinessAssertionError(
        failures.length > 0
          ? `External asset validation failed: ${failures.map(probe => `${probe.label}: ${probe.issue}`).join("; ")}`
          : "No public reserve asset is available for external-chain validation",
        { assets: probes }
      )
    }
    return {
      detail: `${probes.length} public reserve asset(s) resolve to native currency or a deployed token/mint`,
      evidence: { assets: probes }
    }
  })
}

/** Validate active token mappings for every advertised reserve. */
export async function runAssetRegistry<C extends ReadinessContext>(
  context: C,
  _input: SwapReadinessInput,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  await runReadinessAssertion(context, async () => {
    const { chainTokens, reserves } = await readReserveState(context),
      advertised = activePublicReserves(reserves),
      eligible = eligibleReserves(advertised, chainTokens),
      unbound = advertised.filter(reserve => !eligible.includes(reserve))
    if (advertised.length === 0 || unbound.length > 0) {
      throw new ReadinessAssertionError(
        advertised.length === 0
          ? "No public reserve asset is registered"
          : `${unbound.length} public reserve(s) lack an active chain-token binding`,
        { unbound: unbound.map(readinessReserveLabel) }
      )
    }
    return {
      detail: `${eligible.length} public reserve asset(s) have active chain-token bindings`,
      evidence: { eligibleAssets: eligible.length }
    }
  })
}

/** Validate positive public reserve depth across active EVM and SVM chains. */
export async function runPublicReserves<C extends ReadinessContext>(
  context: C,
  _input: SwapReadinessInput,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  await runReadinessAssertion(context, async () => {
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
          ? "Both active EVM and SVM rows are required for cross-chain readiness"
          : publicActive.length === 0
            ? "No public reserve is active"
            : missing.length > 0
              ? `No eligible public reserve is available for ${missing.join(", ")}`
              : `Public reserves have zero liquidity: ${zeroDepth.map(readinessReserveLabel).join(", ")}`,
        {
          missingChainLiquidity: missing,
          zeroDepthReserves: zeroDepth.map(readinessReserveLabel)
        }
      )
    }
    return {
      detail: `${eligible.length} public reserve(s) have positive depth and cover active external chains`,
      evidence: { activePublic: publicActive.length, eligible: eligible.length }
    }
  })
}

/** Validate expired pending underwriting requests are not accumulating. */
export async function runRequestBacklog<C extends ReadinessContext>(
  context: C,
  _input: SwapReadinessInput,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  await runReadinessAssertion(context, async () => {
    const [epochResult, requestsResult, queueResult] = await Promise.all([
        bounded(
          context.readiness.wireSystem.epoch.tables.epochstate.query({
            limit: ReadinessMaxTableRows
          }),
          "sysio.epoch::epochstate"
        ),
        bounded(
          context.readiness.wireSystem.uwrit.tables.uwreqs.query({
            limit: ReadinessMaxTableRows
          }),
          "sysio.uwrit::uwreqs"
        ),
        bounded(
          context.readiness.wireSystem.uwrit.tables.fwqueue.query({
            limit: ReadinessMaxTableRows
          }),
          "sysio.uwrit::fwqueue"
        )
      ]),
      epoch = epochResult.rows[0]
    if (epoch == null) throw new Error("sysio.epoch::epochstate is missing")
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
        {
          currentEpoch: epoch.current_epoch_index,
          staleRequestIds: stale.map(request => request.id),
          queueCount: queueResult.rows.length
        }
      )
    }
    return {
      detail: "No expired PENDING underwriting requests were found",
      evidence: {
        currentEpoch: epoch.current_epoch_index,
        requestCount: requestsResult.rows.length,
        queueCount: queueResult.rows.length
      }
    }
  })
}

/** Construct routes and quote them from the same bounded live table snapshot. */
export async function runRouteRegistry<C extends ReadinessContext>(
  context: C,
  _input: SwapReadinessInput,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  await runReadinessAssertion(context, async () => {
    const routes = await buildReadinessRoutes(context)
    context.outputs.set(ReadinessOutputs.routes, routes)
    if (routes.length === 0) {
      throw new ReadinessAssertionError(
        "No directional route can be constructed from active public reserves"
      )
    }
    return {
      detail: `${routes.length} directional public route(s) were constructed and quoted`,
      evidence: { routes }
    }
  })
}

/** Require every constructed route to pass read-only preflight. */
export async function runRouteQuotes<C extends ReadinessContext>(
  context: C,
  _input: SwapReadinessInput,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  await runReadinessAssertion(context, async () => {
    const routes = context.outputs.get(ReadinessOutputs.routes) ?? [],
      failed = routes.filter(route => !route.preflightReady)
    if (routes.length === 0 || failed.length > 0) {
      throw new ReadinessAssertionError(
        routes.length === 0
          ? "No constructed route is available for quote validation"
          : `${failed.length} directional route(s) fail read-only preflight`,
        { failedRoutes: failed }
      )
    }
    return {
      detail: `All ${routes.length} directional route(s) return a positive canonical depot quote with collateral coverage`,
      evidence: {
        routeCount: routes.length,
        probeDepthDivisor: ReadinessConfig.QuoteProbeDepthDivisor.toString()
      }
    }
  })
}

async function readReserveState<C extends ReadinessContext>(context: C) {
  const [chains, chainTokens, reserves] = await Promise.all([
    bounded(
      context.readiness.wireSystem.chains.tables.chains.query({
        limit: ReadinessMaxTableRows
      }),
      "sysio.chains::chains"
    ),
    bounded(
      context.readiness.wireSystem.tokens.tables.chaintokens.query({
        limit: ReadinessMaxTableRows
      }),
      "sysio.tokens::chaintokens"
    ),
    bounded(
      context.readiness.wireSystem.reserv.tables.reserves.query({
        limit: ReadinessMaxTableRows
      }),
      "sysio.reserv::reserves"
    )
  ])
  return {
    chains: chains.rows,
    chainTokens: chainTokens.rows,
    reserves: reserves.rows
  }
}

function bounded<T extends BoundedQueryResult>(
  operation: Promise<T>,
  label: string
): Promise<T> {
  return readinessBoundedQuery(operation, label)
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
): SysioContracts.SysioReservReserveRowType[] {
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
): SysioContracts.SysioReservReserveRowType[] {
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

/** Available collateral after active locks and pending withdrawals. */
export function availableCollateral(
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

async function buildReadinessRoutes<C extends ReadinessContext>(
  context: C
): Promise<ReadinessRoute[]> {
  const { chains, chainTokens, reserves } = await readReserveState(context),
    config = await context.readiness.wireSystem.uwrit.tables.uwconfig.first(),
    eligible = eligibleReserves(activePublicReserves(reserves), chainTokens),
    buckets = context.outputs.get(ReadinessOutputs.collateralBuckets) ?? [],
    label = (reserve: SysioContracts.SysioReservReserveRowType) => {
      const chain = chains.find(
        candidate =>
          readinessSlugValue(candidate.code) ===
          readinessSlugValue(reserve.chain_code)
      )
      return `${readinessSlug(reserve.token_code)} on ${chain?.name ?? readinessSlug(reserve.chain_code)}`
    },
    direct = eligible.flatMap(reserve => {
      const book = reserveBook(reserve),
        external = label(reserve),
        toWireProbe = probeAmount(book.chain),
        fromWireProbe = probeAmount(book.wire)
      return [
        createRoute(
          external,
          "WIRE",
          toWireProbe,
          WireReserveTool.quoteSwap(book, null, toWireProbe, config.fee_bps),
          [reserve],
          buckets
        ),
        createRoute(
          "WIRE",
          external,
          fromWireProbe,
          WireReserveTool.quoteSwap(null, book, fromWireProbe, config.fee_bps),
          [reserve],
          buckets
        )
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
          const sourceBook = reserveBook(source),
            destinationBook = reserveBook(destination),
            sourceProbe = probeAmount(sourceBook.chain)
          return createRoute(
            label(source),
            label(destination),
            sourceProbe,
            WireReserveTool.quoteSwap(
              sourceBook,
              destinationBook,
              sourceProbe,
              config.fee_bps
            ),
            [source, destination],
            buckets
          )
        })
    )
  return [...direct, ...crossChain]
}

function reserveBook(
  reserve: SysioContracts.SysioReservReserveRowType
): WireReserveTool.ReserveBook {
  return {
    chain: BigInt(reserve.reserve_chain_amount),
    wire: BigInt(reserve.reserve_wire_amount),
    connectorWeightBps: reserve.connector_weight_bps,
    ownerFeeBps: reserve.owner_fee_bps
  }
}

function createRoute(
  source: string,
  destination: string,
  sourceAmount: bigint,
  destinationAmount: bigint,
  reserves: SysioContracts.SysioReservReserveRowType[],
  buckets: ReadinessCollateralBucket[]
): ReadinessRoute {
  const routeBuckets = reserves.map(reserve =>
      buckets.find(
        bucket =>
          bucket.chainCode === readinessSlugValue(reserve.chain_code) &&
          bucket.tokenCode === readinessSlugValue(reserve.token_code)
      )
    ),
    commonUnderwriters = routeBuckets.reduce<string[]>(
      (accounts, bucket, index) =>
        index === 0
          ? (bucket?.accounts ?? [])
          : accounts.filter(account => bucket?.accounts.includes(account)),
      []
    ),
    issues = [
      ...routeBuckets.flatMap((bucket, index) =>
        bucket == null
          ? [
              `${readinessReserveLabel(reserves[index])}: collateral evidence is unavailable`
            ]
          : bucket.ready
            ? []
            : [`${bucket.label}: ${bucket.issues.join(", ")}`]
      ),
      routeBuckets.length > 1 && commonUnderwriters.length === 0
        ? "no single ACTIVE underwriter can cover both external legs"
        : null,
      destinationAmount <= 0n ? "canonical depot quote returned zero" : null
    ].filter((issue): issue is string => issue != null)
  return {
    source,
    destination,
    quotedSourceAmount: sourceAmount.toString(),
    quotedDestinationAmount: destinationAmount.toString(),
    preflightReady: issues.length === 0,
    issues
  }
}

function probeAmount(depth: bigint): bigint {
  const scaled = depth / ReadinessConfig.QuoteProbeDepthDivisor
  return scaled > 0n ? scaled : 1n
}

function failedAsset(
  label: string,
  address: string,
  issue: string
): ExternalAssetProbe {
  return { label, native: false, address, deployed: false, issue }
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
