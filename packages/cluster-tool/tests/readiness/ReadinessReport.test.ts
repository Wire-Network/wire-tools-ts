import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"

import {
  ClusterReadinessArea,
  ClusterReadinessCheckId,
  ClusterReadinessCheckStatus,
  ClusterReadinessFeature
} from "@wireio/cluster-tool-shared"
import { getLogger } from "@wireio/cluster-tool/logging"
import { Report } from "@wireio/cluster-tool/report"
import {
  ReadinessContext,
  ReadinessOutputs,
  ReadinessReportExporter,
  ReadinessTerminalRenderer,
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
      "CANARY NOT RUN"
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

  it("exports only JSON and native orchestration HTML in one tar.gz", async () => {
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
        archive = await new ReadinessReportExporter(projected, orchestration, {
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
