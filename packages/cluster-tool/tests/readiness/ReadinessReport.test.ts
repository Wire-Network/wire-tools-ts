import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"

import {
  ClusterFeatureReadinessState,
  ClusterReadinessArea,
  ClusterReadinessCheckId,
  ClusterReadinessCheckStatus,
  ClusterReadinessFeature,
  ClusterReadinessReasonCode,
  type ClusterReadinessReport
} from "@wireio/cluster-tool-shared"
import { getLogger } from "@wireio/cluster-tool/logging"
import { Report } from "@wireio/cluster-tool/report"
import {
  ReadinessContext,
  ReadinessHtmlRenderer,
  ReadinessOutputs,
  ReadinessReportExporter,
  ReadinessTerminalRenderer,
  presentReadiness,
  projectReadinessReport
} from "@wireio/cluster-tool/readiness"

import { createReadinessDeploymentProfileFixture } from "./readinessProfileFixture.js"

const WireChainId = "b".repeat(64)

function readyContext(strict = false): ReadinessContext {
  const context = new ReadinessContext(
    {
      feature: ClusterReadinessFeature.swap,
      catalogUrl: "https://catalog.example",
      requestedWireChainId: WireChainId,
      ...(strict
        ? {
            outpostDeploymentProfile: createReadinessDeploymentProfileFixture()
          }
        : {}),
      endpoints: [],
      catalogRecordCount: 0,
      catalogErrors: [],
      observationMs: 1,
      timeoutMs: 1,
      report: { path: "/tmp", basename: "readiness", formats: [] }
    },
    getLogger("readiness-report-test")
  )
  const required = Object.values(ClusterReadinessCheckId).filter(
    id =>
      id !== ClusterReadinessCheckId["discovery.endpoint-catalog"] &&
      id !== ClusterReadinessCheckId["hyperion.health"] &&
      id !== ClusterReadinessCheckId["stake.lifecycle"] &&
      (strict ||
        (id !== ClusterReadinessCheckId["wire.deployment-profile"] &&
          id !== ClusterReadinessCheckId["ethereum.deployment-profile"] &&
          id !== ClusterReadinessCheckId["solana.deployment-profile"] &&
          id !== ClusterReadinessCheckId["swap.external-custody"]))
  )
  context.outputs.set(
    ReadinessOutputs.checks,
    required.map(id => ({
      id,
      area: id.startsWith("discovery.")
        ? ClusterReadinessArea.discovery
        : id.startsWith("swap.")
          ? ClusterReadinessArea.swap
          : ClusterReadinessArea.cluster,
      status: ClusterReadinessCheckStatus.pass,
      blocking: true,
      detail: "passed"
    }))
  )
  context.outputs.set(ReadinessOutputs.observedWireChainId, WireChainId)
  return context
}

function reportWithGranularGaps(): ClusterReadinessReport {
  const projected = projectReadinessReport(
    readyContext(true),
    new Report(),
    new Date("2026-08-04T12:00:00.000Z"),
    new Date("2026-08-04T12:00:01.000Z")
  )
  return {
    ...projected,
    checks: projected.checks.map(check => {
      if (check.id === ClusterReadinessCheckId["swap.active-underwriters"]) {
        return {
          ...check,
          status: ClusterReadinessCheckStatus.fail,
          reason: ClusterReadinessReasonCode["configuration-incomplete"],
          detail: "Underwriter collateral requirements are incomplete",
          evidence: {
            advertisedBuckets: [
              {
                label: "ETHEREUM/LIQETH",
                minimum: "0",
                accounts: [],
                ready: false,
                issues: ["collateral requirement is missing"]
              },
              {
                label: "SOLANA/SOL",
                minimum: "1000",
                accounts: ["underwriter"],
                ready: true,
                issues: []
              }
            ]
          }
        }
      }
      if (check.id === ClusterReadinessCheckId["swap.external-custody"]) {
        return {
          ...check,
          status: ClusterReadinessCheckStatus.fail,
          reason: ClusterReadinessReasonCode["configuration-incomplete"],
          detail: "External custody configuration failed",
          evidence: {
            reserves: [
              {
                label: "ETHEREUM/LIQETH/PRIMARY",
                configured: false,
                funded: false,
                ready: false,
                issues: [
                  "local reserve record is missing",
                  "external custody balance is zero"
                ],
                balance: "0"
              },
              {
                label: "SOLANA/SOL/PRIMARY",
                configured: true,
                funded: true,
                ready: true,
                issues: [],
                balance: "20000000000"
              }
            ]
          }
        }
      }
      return check
    }),
    routes: [
      {
        source: "WIRE",
        destination: "SOL on Solana",
        preflightReady: true,
        quotedSourceAmount: "10000000",
        quotedDestinationAmount: "9960069",
        transactionallyVerified: false,
        detail: "Preflight passes; canary required"
      },
      {
        source: "WIRE",
        destination: "LIQETH on Ethereum",
        preflightReady: false,
        quotedSourceAmount: "10000000",
        quotedDestinationAmount: "9960069",
        transactionallyVerified: false,
        detail: "Blocked: custody and collateral are missing"
      }
    ],
    summary: {
      ...projected.summary,
      featurePreflightReady: false,
      swapPreflightReady: false,
      featureState: ClusterFeatureReadinessState.blocked,
      swapState: ClusterFeatureReadinessState.blocked
    }
  }
}

describe("readiness reports", () => {
  it("projects preflight readiness without claiming transactional proof", () => {
    const projected = projectReadinessReport(
      readyContext(),
      new Report(),
      new Date("2026-08-04T12:00:00.000Z"),
      new Date("2026-08-04T12:00:01.000Z")
    )
    expect(projected.summary.clusterLive).toBe(true)
    expect(projected.summary.swapPreflightReady).toBe(true)
    expect(projected.summary.swapReady).toBe(false)
    expect(new ReadinessTerminalRenderer(projected).render()).toContain(
      "0/0 transactionally verified"
    )
    expect(new ReadinessTerminalRenderer(projected).render()).toContain(
      "no deployment profile was supplied"
    )
  })

  it("requires exact deployment and custody checks when a profile is supplied", () => {
    const context = readyContext(true)
    context.outputs.set(
      ReadinessOutputs.checks,
      context.outputs
        .assert(ReadinessOutputs.checks)
        .filter(
          check => check.id !== ClusterReadinessCheckId["swap.external-custody"]
        )
    )

    const projected = projectReadinessReport(
      context,
      new Report(),
      new Date("2026-08-04T12:00:00.000Z"),
      new Date("2026-08-04T12:00:01.000Z")
    )

    expect(projected.summary.swapPreflightReady).toBe(false)
    expect(new ReadinessTerminalRenderer(projected).render()).toContain(
      "Strict deployment identity and external custody checks ran using the supplied profile"
    )
    expect(new ReadinessTerminalRenderer(projected).render()).not.toContain(
      "no deployment profile was supplied"
    )
  })

  it("fails closed when one required check is absent", () => {
    const context = readyContext()
    context.outputs.set(
      ReadinessOutputs.checks,
      context.outputs
        .assert(ReadinessOutputs.checks)
        .filter(
          check =>
            check.id !== ClusterReadinessCheckId["swap.active-underwriters"]
        )
    )
    const projected = projectReadinessReport(
      context,
      new Report(),
      new Date("2026-08-04T12:00:00.000Z"),
      new Date("2026-08-04T12:00:01.000Z")
    )
    expect(projected.summary.clusterLive).toBe(true)
    expect(projected.summary.swapPreflightReady).toBe(false)
  })

  it("keeps cluster liveness independent from swap protocol readiness", () => {
    const context = readyContext()
    context.outputs.set(
      ReadinessOutputs.checks,
      context.outputs
        .assert(ReadinessOutputs.checks)
        .filter(check => check.id !== ClusterReadinessCheckId["wire.contracts"])
    )
    const projected = projectReadinessReport(
      context,
      new Report(),
      new Date("2026-08-04T12:00:00.000Z"),
      new Date("2026-08-04T12:00:01.000Z")
    )
    expect(projected.summary.clusterLive).toBe(true)
    expect(projected.summary.swapPreflightReady).toBe(false)
  })

  it("aligns terminal and HTML around exact granular missing items", () => {
    const report = reportWithGranularGaps(),
      presentation = presentReadiness(report),
      terminal = new ReadinessTerminalRenderer(report).render(),
      html = new ReadinessHtmlRenderer(report).render()

    expect(presentation.missing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "collateral",
          label: "ETHEREUM/LIQETH",
          issues: ["collateral requirement is missing"]
        }),
        expect.objectContaining({
          category: "custody",
          label: "ETHEREUM/LIQETH/PRIMARY",
          issues: [
            "local reserve record is missing",
            "external custody balance is zero"
          ]
        })
      ])
    )
    expect(terminal).toContain("STILL MISSING ON THIS CLUSTER")
    expect(terminal).toContain("[COLLATERAL] ETHEREUM/LIQETH")
    expect(terminal).toContain("[CUSTODY] ETHEREUM/LIQETH/PRIMARY")
    expect(terminal).toContain("HEALTHY NOW")
    expect(html).toContain("Still missing on this cluster")
    expect(html).toContain("ETHEREUM/LIQETH/PRIMARY")
    expect(html).toContain("Healthy now")
    expect(html).toContain("Granular checks")
  })

  it("aligns terminal and HTML around transactional route evidence", () => {
    const report = reportWithGranularGaps()
    report.routes[0].transactionallyVerified = true
    const terminal = new ReadinessTerminalRenderer(report).render(),
      html = new ReadinessHtmlRenderer(report).render()

    expect(terminal).toContain("1/2 transactionally verified")
    expect(html).toContain("1 transactionally verified")
    expect(html).toContain("1 verified")
  })

  it("exports only JSON and operator-focused readiness HTML in one tar.gz", async () => {
    const rootPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), "readiness-export-"))
    try {
      const orchestration = new Report()
      orchestration.name = "swap-readiness"
      const projected = projectReadinessReport(
          readyContext(),
          orchestration,
          new Date("2026-08-04T12:00:00.000Z"),
          new Date("2026-08-04T12:00:01.000Z")
        ),
        archive = await new ReadinessReportExporter(projected, {
          rootPath
        }).exportArchive()
      expect(Path.basename(archive.archiveFile)).toMatch(
        /^wire-cluster-b{12}-swap-readiness-report-.*\.tar\.gz$/
      )
      expect(Fs.statSync(archive.archiveFile).size).toBeGreaterThan(0)
      expect([archive.jsonFileName, archive.htmlFileName]).toEqual([
        `${archive.reportName}.json`,
        `${archive.reportName}.html`
      ])
    } finally {
      Fs.rmSync(rootPath, { recursive: true, force: true })
    }
  })
})
