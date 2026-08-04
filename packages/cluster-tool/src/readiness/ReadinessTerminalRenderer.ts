import {
  type ClusterReadinessCheck,
  ClusterReadinessCheckId,
  ClusterReadinessCheckStatus,
  ClusterReadinessEndpointKind,
  ClusterReadinessFeature,
  type ClusterReadinessReport
} from "@wireio/cluster-tool-shared"

const CheckLabels: Record<ClusterReadinessCheckId, string> = {
  "discovery.endpoint-catalog": "Endpoint catalog",
  "discovery.required-endpoints": "Network group discovery",
  "wire.identity": "Wire chain identity",
  "wire.head-advancement": "Wire block production",
  "wire.head-freshness": "Wire head freshness",
  "ethereum.identity": "Ethereum chain identity",
  "ethereum.head-advancement": "Ethereum block production",
  "solana.identity": "Solana cluster identity",
  "solana.slot-advancement": "Solana slot production",
  "hyperion.health": "Hyperion indexing",
  "wire.contracts": "Wire swap contract surface",
  "wire.epoch-scheduler": "Epoch scheduler",
  "wire.chain-registry": "External chain registry",
  "swap.underwriting-config": "Underwriting policy",
  "swap.active-underwriters": "Underwriter collateral",
  "swap.external-assets": "External token deployments",
  "swap.asset-registry": "Public asset registry",
  "swap.public-reserves": "Public reserve funding",
  "swap.route-registry": "Directional route coverage",
  "swap.route-quotes": "Positive read-only quotes",
  "swap.request-backlog": "Request backlog",
  "stake.lifecycle": "LIQ stake/unstake lifecycle"
}

const EndpointLabels: Record<ClusterReadinessEndpointKind, string> = {
  [ClusterReadinessEndpointKind.wire]: "WIRE",
  [ClusterReadinessEndpointKind.hyperion]: "HYP",
  [ClusterReadinessEndpointKind.ethereum]: "EVM",
  [ClusterReadinessEndpointKind.solana]: "SVM"
}

enum Ansi {
  reset = "\u001b[0m",
  bold = "\u001b[1m",
  dim = "\u001b[2m",
  red = "\u001b[31m",
  green = "\u001b[32m",
  yellow = "\u001b[33m",
  cyan = "\u001b[36m",
  gray = "\u001b[90m"
}

/** Terminal presentation controls. */
export interface ReadinessTerminalRendererOptions {
  /** Emit ANSI colors. */
  color?: boolean
}

/** Render a concise colored operator summary from the stable readiness report. */
export class ReadinessTerminalRenderer {
  /** Creates a terminal renderer for one completed readiness report. */
  constructor(
    private readonly report: ClusterReadinessReport,
    private readonly options: ReadinessTerminalRendererOptions = {}
  ) {}

  /** Return deterministic plain or ANSI-colored text. */
  render(): string {
    const { color = false } = this.options,
      { report } = this,
      feature = report.feature.toUpperCase(),
      blockers = report.checks.filter(
        check =>
          check.blocking && check.status === ClusterReadinessCheckStatus.fail
      ),
      advisories = report.checks.filter(
        check => check.status === ClusterReadinessCheckStatus.advisory
      ),
      passed = report.checks.filter(
        check => check.status === ClusterReadinessCheckStatus.pass
      ).length,
      positiveRoutes = report.routes.filter(
        route => route.preflightReady
      ).length,
      lines = [
        paint(
          color,
          `${Ansi.bold}${Ansi.cyan}`,
          `╭─ WIRE · ${feature} READINESS`
        ),
        summaryRow(
          "Result",
          report.summary.featurePreflightReady
            ? paint(color, Ansi.green, "READ-ONLY READY")
            : paint(color, Ansi.red, "BLOCKED")
        ),
        summaryRow(
          "Cluster",
          report.summary.clusterLive
            ? paint(color, Ansi.green, "HEALTHY")
            : paint(color, Ansi.red, "UNHEALTHY")
        ),
        summaryRow(
          "Checks",
          `${passed}/${report.checks.length} passed · ${blockers.length} blocker(s) · ${advisories.length} advisory`
        )
      ]

    if (report.feature === ClusterReadinessFeature.swap) {
      lines.push(
        summaryRow(
          "Routes",
          `${positiveRoutes}/${report.routes.length} quote-positive`
        ),
        summaryRow("Settlement", paint(color, Ansi.yellow, "CANARY NOT RUN"))
      )
    }

    lines.push(
      summaryRow("Duration", `${(report.durationMs / 1_000).toFixed(1)}s`),
      paint(
        color,
        Ansi.dim,
        `╰─ ${report.generatedAt} · chain ${report.observedWireChainId ?? report.requestedWireChainId ?? "unknown"}`
      ),
      "",
      paint(color, Ansi.bold, "NETWORK GROUP"),
      ...endpointLines(report, color)
    )

    if (blockers.length > 0) {
      lines.push("", paint(color, `${Ansi.bold}${Ansi.red}`, "BLOCKERS"))
      blockers.forEach(check => lines.push(checkLines(check, color)))
    }

    lines.push("", paint(color, Ansi.bold, "CHECKS"))
    report.checks.forEach(check => lines.push(checkLines(check, color)))

    if (
      report.feature === ClusterReadinessFeature.swap &&
      report.routes.length > 0
    ) {
      lines.push(
        "",
        paint(color, Ansi.bold, "ROUTE COVERAGE"),
        ...routeCoverageLines(report, color)
      )
    }

    lines.push(
      "",
      paint(color, `${Ansi.bold}${Ansi.yellow}`, "PROOF BOUNDARY"),
      `  ${proofBoundary(report.feature)}`,
      "",
      report.summary.featurePreflightReady
        ? paint(
            color,
            Ansi.green,
            `Result: ${report.feature} read-only infrastructure preflight passed.`
          )
        : paint(
            color,
            Ansi.red,
            `Result: ${report.feature} readiness is blocked; resolve the failures above.`
          )
    )
    return lines.join("\n")
  }
}

function paint(enabled: boolean, code: string, value: string): string {
  return enabled ? `${code}${value}${Ansi.reset}` : value
}

function summaryRow(label: string, value: string): string {
  return `│  ${label.padEnd(16)} ${value}`
}

function checkLines(check: ClusterReadinessCheck, color: boolean): string {
  const marker =
      check.status === ClusterReadinessCheckStatus.pass
        ? paint(color, Ansi.green, "✓ PASS")
        : check.status === ClusterReadinessCheckStatus.fail
          ? paint(color, Ansi.red, "✗ FAIL")
          : paint(color, Ansi.yellow, "! NOTE"),
    reason = check.reason ? ` · ${check.reason}` : "",
    advisory = check.blocking ? "" : " · advisory"
  return `  ${marker}  ${CheckLabels[check.id]}${reason}${advisory}\n          ${check.detail}`
}

function endpointLines(
  report: ClusterReadinessReport,
  color: boolean
): string[] {
  if (report.endpoints.length === 0) return ["  none selected"]
  return report.endpoints.map(endpoint => {
    const identity = endpoint.expectedChainId
      ? `\n          identity ${endpoint.expectedChainId}`
      : ""
    return (
      `  ${paint(color, Ansi.cyan, EndpointLabels[endpoint.kind].padEnd(4))}  ` +
      `${endpoint.url}${endpoint.name ? ` · ${endpoint.name}` : ""} · ${endpoint.source}${identity}`
    )
  })
}

function routeCoverageLines(
  report: ClusterReadinessReport,
  color: boolean
): string[] {
  const groups = [
      {
        label: "External → WIRE",
        routes: report.routes.filter(route => route.destination === "WIRE")
      },
      {
        label: "WIRE → external",
        routes: report.routes.filter(route => route.source === "WIRE")
      },
      {
        label: "Cross-outpost",
        routes: report.routes.filter(
          route => route.source !== "WIRE" && route.destination !== "WIRE"
        )
      }
    ],
    lines = groups.map(({ label, routes }) => {
      const ready = routes.filter(route => route.preflightReady).length
      return `  ${label.padEnd(20)} ${paint(
        color,
        ready === routes.length && routes.length > 0 ? Ansi.green : Ansi.red,
        `${ready}/${routes.length} quote-positive`
      )}`
    }),
    failed = report.routes.filter(route => !route.preflightReady)

  if (failed.length > 0) {
    lines.push("", paint(color, Ansi.red, "  Zero-quote routes:"))
    failed.forEach(route =>
      lines.push(`    ${route.source} → ${route.destination}`)
    )
  }
  return lines
}

function proofBoundary(feature: ClusterReadinessFeature): string {
  return feature === ClusterReadinessFeature.swap
    ? "Read-only evidence does not prove external custody, OPP daemon circulation, final settlement, or SWAP_REVERT refunds; those require a funded canary."
    : "Staking is intentionally nonfunctional until a canonical cross-chain LIQ lifecycle is deployed and proven."
}
