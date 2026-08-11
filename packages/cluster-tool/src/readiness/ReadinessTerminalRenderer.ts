import {
  type ClusterReadinessCheck,
  ClusterReadinessCheckStatus,
  ClusterReadinessEndpointKind,
  ClusterReadinessFeature,
  type ClusterReadinessReport
} from "@wireio/cluster-tool-shared"

import {
  presentReadiness,
  ReadinessCheckLabels,
  readinessProofBoundary,
  type ReadinessMissingItem,
  type ReadinessPresentation
} from "./ReadinessPresentation.js"

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
      view = presentReadiness(report),
      feature = report.feature.toUpperCase(),
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
          `${view.passed.length}/${report.checks.length} passed · ${view.blockers.length} blocker(s) · ${view.advisories.length} advisory`
        )
      ]

    if (report.feature === ClusterReadinessFeature.swap) {
      lines.push(
        summaryRow(
          "Routes",
          `${view.readyRoutes.length}/${report.routes.length} preflight-ready`
        ),
        summaryRow(
          "Settlement",
          paint(
            color,
            view.transactionallyVerifiedRoutes.length === report.routes.length &&
              report.routes.length > 0
              ? Ansi.green
              : Ansi.yellow,
            `${view.transactionallyVerifiedRoutes.length}/${report.routes.length} transactionally verified`
          )
        )
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
      paint(
        color,
        `${Ansi.bold}${view.missing.length > 0 ? Ansi.red : Ansi.green}`,
        "STILL MISSING ON THIS CLUSTER"
      ),
      ...missingLines(view.missing, color),
      "",
      paint(color, `${Ansi.bold}${Ansi.yellow}`, "NOT YET PROVEN"),
      "  - Funded test-wallet balances, ERC-20 allowances, and Solana token accounts are not inspected.",
      "  - OPP circulation, settlement, delivery, and refunds require funded canaries.",
      "",
      paint(color, `${Ansi.bold}${Ansi.green}`, "HEALTHY NOW"),
      ...healthyLines(report, view, color),
      "",
      paint(color, Ansi.bold, "NETWORK GROUP"),
      ...endpointLines(report, color)
    )

    lines.push("", paint(color, Ansi.bold, "GRANULAR CHECKS"))
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
      `  ${readinessProofBoundary(report)}`,
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
  return `  ${marker}  ${ReadinessCheckLabels[check.id]}${reason}${advisory}\n          ${check.detail}`
}

function missingLines(
  missing: ReadinessMissingItem[],
  color: boolean
): string[] {
  if (missing.length === 0) {
    return [paint(color, Ansi.green, "  none")]
  }
  return missing.flatMap(item => [
    `  ${paint(color, Ansi.red, "-")} [${item.category.toUpperCase()}] ${item.label}`,
    `      ${item.issues.join("; ")}`,
    ...(item.facts.length > 0 ? [`      ${item.facts.join(" · ")}`] : [])
  ])
}

function healthyLines(
  report: ClusterReadinessReport,
  view: ReadinessPresentation,
  color: boolean
): string[] {
  const readyCollateral = view.collateral.filter(state => state.ready),
    readyCustody = view.custody.filter(state => state.ready),
    lines = [
      `  ${paint(color, report.summary.clusterLive ? Ansi.green : Ansi.red, report.summary.clusterLive ? "✓" : "✗")} Cluster ${report.summary.clusterLive ? "is healthy and advancing" : "is not healthy"}`,
      `  ${paint(color, Ansi.green, "✓")} ${view.passed.length}/${report.checks.length} checks pass`,
      `  ${paint(color, readyCollateral.length === view.collateral.length ? Ansi.green : Ansi.yellow, "•")} Collateral ${readyCollateral.length}/${view.collateral.length} ready${readyCollateral.length > 0 ? ` — ${readyCollateral.map(state => state.label).join(", ")}` : ""}`,
      `  ${paint(color, readyCustody.length === view.custody.length ? Ansi.green : Ansi.yellow, "•")} Custody ${readyCustody.length}/${view.custody.length} ready${readyCustody.length > 0 ? ` — ${readyCustody.map(state => state.label).join(", ")}` : ""}`,
      `  ${paint(color, view.readyRoutes.length === report.routes.length ? Ansi.green : Ansi.yellow, "•")} Routes ${view.readyRoutes.length}/${report.routes.length} preflight-ready`
    ]
  if (view.readyRoutes.length > 0) {
    lines.push(
      ...view.readyRoutes.map(
        route => `      ${route.source} → ${route.destination}`
      )
    )
  }
  return lines
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
        `${ready}/${routes.length} preflight-ready`
      )}`
    }),
    ready = report.routes.filter(route => route.preflightReady),
    failed = report.routes.filter(route => !route.preflightReady)

  if (ready.length > 0) {
    lines.push("", paint(color, Ansi.green, "  Preflight-ready routes:"))
    ready.forEach(route =>
      lines.push(
        `    ${route.source} → ${route.destination} · ${route.quotedSourceAmount} → ${route.quotedDestinationAmount}`
      )
    )
  }

  if (failed.length > 0) {
    lines.push("", paint(color, Ansi.red, "  Blocked routes:"))
    failed.forEach(route =>
      lines.push(
        `    ${route.source} → ${route.destination}\n      ${route.detail}`
      )
    )
  }
  return lines
}
