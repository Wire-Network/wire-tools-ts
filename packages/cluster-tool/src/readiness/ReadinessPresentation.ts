import {
  type ClusterReadinessCheck,
  ClusterReadinessCheckId,
  ClusterReadinessCheckStatus,
  ClusterReadinessFeature,
  type ClusterReadinessReport,
  type ClusterSwapRouteReadiness
} from "@wireio/cluster-tool-shared"

/** Stable operator-facing names shared by terminal and HTML readiness reports. */
export const ReadinessCheckLabels: Record<ClusterReadinessCheckId, string> = {
  "discovery.endpoint-catalog": "Endpoint catalog",
  "discovery.required-endpoints": "Network group discovery",
  "wire.identity": "Wire chain identity",
  "wire.head-advancement": "Wire block production",
  "wire.head-freshness": "Wire head freshness",
  "wire.deployment-profile": "Wire deployment profile",
  "ethereum.identity": "Ethereum chain identity",
  "ethereum.head-advancement": "Ethereum block production",
  "ethereum.deployment-profile": "Ethereum implementation identity",
  "solana.identity": "Solana cluster identity",
  "solana.slot-advancement": "Solana slot production",
  "solana.deployment-profile": "Solana ProgramData identity",
  "hyperion.health": "Hyperion indexing",
  "wire.contracts": "Wire swap contract surface",
  "wire.epoch-scheduler": "Epoch scheduler",
  "wire.chain-registry": "External chain registry",
  "swap.underwriting-config": "Underwriting policy",
  "swap.active-underwriters": "Underwriter collateral",
  "swap.external-assets": "External token deployments",
  "swap.external-custody": "External reserve custody",
  "swap.asset-registry": "Public asset registry",
  "swap.public-reserves": "Public reserve funding",
  "swap.route-registry": "Directional route coverage",
  "swap.route-quotes": "Route infrastructure preflight",
  "swap.request-backlog": "Request backlog",
  "stake.lifecycle": "LIQ stake/unstake lifecycle"
}

/** Stable categories for configuration gaps shown in readiness reports. */
export enum ReadinessMissingCategory {
  collateral = "collateral",
  custody = "custody",
  quote = "quote",
  check = "check"
}

/** One verified configuration gap extracted from granular check evidence. */
export interface ReadinessMissingItem {
  category: ReadinessMissingCategory
  label: string
  issues: string[]
  facts: string[]
}

/** One granular collateral or custody row, whether healthy or missing. */
export interface ReadinessAssetState {
  label: string
  ready: boolean
  issues: string[]
  facts: string[]
}

/** Shared presentation model consumed by both human-readable renderers. */
export interface ReadinessPresentation {
  blockers: ClusterReadinessCheck[]
  advisories: ClusterReadinessCheck[]
  passed: ClusterReadinessCheck[]
  missing: ReadinessMissingItem[]
  collateral: ReadinessAssetState[]
  custody: ReadinessAssetState[]
  readyRoutes: ClusterSwapRouteReadiness[]
  blockedRoutes: ClusterSwapRouteReadiness[]
  transactionallyVerifiedRoutes: ClusterSwapRouteReadiness[]
}

/** Derive one cohesive operator view without changing the stable JSON schema. */
export function presentReadiness(
  report: ClusterReadinessReport
): ReadinessPresentation {
  const blockers = report.checks.filter(
      check =>
        check.blocking && check.status === ClusterReadinessCheckStatus.fail
    ),
    advisories = report.checks.filter(
      check => check.status === ClusterReadinessCheckStatus.advisory
    ),
    passed = report.checks.filter(
      check => check.status === ClusterReadinessCheckStatus.pass
    ),
    collateral = collateralStates(report),
    custody = custodyStates(report),
    missing: ReadinessMissingItem[] = [
      ...collateral
        .filter(state => !state.ready)
        .map(state => ({
          category: ReadinessMissingCategory.collateral,
          label: state.label,
          issues: state.issues,
          facts: state.facts
        })),
      ...custody
        .filter(state => !state.ready)
        .map(state => ({
          category: ReadinessMissingCategory.custody,
          label: state.label,
          issues: state.issues,
          facts: state.facts
        }))
    ],
    specialized = new Set<ClusterReadinessCheckId>([
      ClusterReadinessCheckId["swap.active-underwriters"],
      ClusterReadinessCheckId["swap.external-custody"],
      ClusterReadinessCheckId["swap.route-quotes"]
    ])

  blockers
    .filter(check => !specialized.has(check.id))
    .forEach(check =>
      missing.push({
        category: ReadinessMissingCategory.check,
        label: ReadinessCheckLabels[check.id],
        issues: [check.detail],
        facts: check.reason ? [`reason ${check.reason}`] : []
      })
    )

  report.routes
    .filter(route => isZero(route.quotedDestinationAmount))
    .forEach(route =>
      missing.push({
        category: ReadinessMissingCategory.quote,
        label: `${route.source} → ${route.destination}`,
        issues: ["canonical depot quote returned zero"],
        facts: [`source probe ${route.quotedSourceAmount}`]
      })
    )

  const routeCheck = blockers.find(
    check => check.id === ClusterReadinessCheckId["swap.route-quotes"]
  )
  if (routeCheck && report.routes.length === 0) {
    missing.push({
      category: ReadinessMissingCategory.check,
      label: ReadinessCheckLabels[routeCheck.id],
      issues: [routeCheck.detail],
      facts: routeCheck.reason ? [`reason ${routeCheck.reason}`] : []
    })
  }

  return {
    blockers,
    advisories,
    passed,
    missing,
    collateral,
    custody,
    readyRoutes: report.routes.filter(route => route.preflightReady),
    blockedRoutes: report.routes.filter(route => !route.preflightReady),
    transactionallyVerifiedRoutes: report.routes.filter(
      route => route.transactionallyVerified
    )
  }
}

/** Explain the deliberate boundary between preflight and transactional proof. */
export function readinessProofBoundary(report: ClusterReadinessReport): string {
  if (report.feature !== ClusterReadinessFeature.swap) {
    return "Staking is intentionally nonfunctional until a canonical cross-chain LIQ lifecycle is deployed and proven."
  }
  const strictProfileChecked = report.checks.some(
    check => check.id === ClusterReadinessCheckId["wire.deployment-profile"]
  )
  return strictProfileChecked
    ? "Strict deployment identity and external custody checks ran using the supplied profile. Funded test-wallet balances, approvals, Solana token accounts, OPP daemon circulation, final settlement, and SWAP_REVERT refunds still require transactional canaries."
    : "Exact outpost deployment identity and external custody were not checked because no deployment profile was supplied. Funded test-wallet state, OPP daemon circulation, final settlement, and SWAP_REVERT refunds require strict readiness plus transactional canaries."
}

function collateralStates(
  report: ClusterReadinessReport
): ReadinessAssetState[] {
  const check = report.checks.find(
      candidate =>
        candidate.id === ClusterReadinessCheckId["swap.active-underwriters"]
    ),
    rows = objectArray(check?.evidence?.advertisedBuckets)
  return rows.map(row => {
    const accounts = stringArray(row.accounts),
      minimum = stringValue(row.minimum)
    return {
      label: stringValue(row.label, "unknown collateral bucket"),
      ready: row.ready === true,
      issues: stringArray(row.issues),
      facts: [
        minimum ? `minimum ${minimum}` : null,
        accounts.length > 0
          ? `ready underwriters ${accounts.join(", ")}`
          : "ready underwriters none"
      ].filter((value): value is string => value != null)
    }
  })
}

function custodyStates(report: ClusterReadinessReport): ReadinessAssetState[] {
  const check = report.checks.find(
      candidate =>
        candidate.id === ClusterReadinessCheckId["swap.external-custody"]
    ),
    rows = objectArray(check?.evidence?.reserves)
  return rows.map(row => ({
    label: stringValue(row.label, "unknown custody reserve"),
    ready: row.ready === true,
    issues: stringArray(row.issues),
    facts: [
      `local record configured ${row.configured === true ? "yes" : "no"}`,
      `reserve funding ready ${row.funded === true ? "yes" : "no"}`,
      row.balance == null
        ? null
        : `observed external balance ${stringValue(row.balance)}`
    ].filter((value): value is string => value != null)
  }))
}

function objectArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> =>
          entry != null && typeof entry === "object" && !Array.isArray(entry)
      )
    : []
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : []
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : fallback
}

function isZero(value: string): boolean {
  return /^0+$/.test(value)
}
