import {
  ClusterFeatureReadinessState,
  ClusterReadinessFeature,
  ClusterReadinessReportSchemaCodec
} from "@wireio/cluster-tool-shared"

describe("ClusterReadinessReportSchemaCodec", () => {
  it("round-trips the stable readiness envelope", () => {
    const report = {
      schemaVersion: 1,
      feature: ClusterReadinessFeature.swap,
      generatedAt: "2026-08-04T12:00:00.000Z",
      durationMs: 50,
      catalogUrl: "https://api.wire.foundation/rpc-endpoints",
      endpoints: [],
      checks: [],
      routes: [],
      summary: {
        feature: ClusterReadinessFeature.swap,
        clusterLive: false,
        featurePreflightReady: false,
        featureReady: false,
        featureState: ClusterFeatureReadinessState.blocked,
        swapPreflightReady: false,
        swapReady: false,
        swapState: ClusterFeatureReadinessState.blocked,
        stakeReady: false,
        stakeState: ClusterFeatureReadinessState.notRun
      }
    }
    expect(
      ClusterReadinessReportSchemaCodec.deserialize(
        ClusterReadinessReportSchemaCodec.serialize(report)
      )
    ).toEqual(report)
  })
})
