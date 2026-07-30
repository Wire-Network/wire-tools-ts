import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import {
  RunEvidenceEndpoint,
  type EnvelopeMetricRecord,
  type EnvelopeMetricSnapshot,
  type EnvelopeRecordSource
} from "@wireio/test-opp-stress"

import {
  DuplexRequiredEndpoints,
  EstimatedAttestationBytes,
  LoadLevel,
  LoadProfile,
  measureDuplexIteration,
  OutboundSampleIntervalMs,
  startOutboundSampling
} from "@wireio/opp-stress-harness"

const Profile = LoadProfile.resolve({ level: LoadLevel.saturating }),
  /** Swaps per epoch that clear the saturating profile's inferred inbound gate. */
  SaturatingInboundSwaps = Math.ceil(
    Profile.saturatedEnvelopeMinBytes / EstimatedAttestationBytes
  )

/** Build a snapshot of one depot→outpost envelope of the requested size. */
function snapshotOf(
  records: readonly EnvelopeMetricRecord[]
): EnvelopeMetricSnapshot {
  return {
    kind: "collected",
    records,
    candidateCount: records.length,
    issues: []
  }
}

/** One outbound record keyed by epoch, sized to `byteLength`. */
function recordOf(epochIndex: number, byteLength: number): EnvelopeMetricRecord {
  const checksum = String(epochIndex).padStart(16, "0")
  return {
    baseKey: `${String(epochIndex).padStart(8, "0")}-DEPOT_OUTPOST_ETHEREUM-${checksum}`,
    epochIndex,
    endpointsType: DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM,
    checksum,
    epochEnvelopeIndex: 0,
    dataBytes: new Uint8Array(byteLength),
    batchOpNames: []
  }
}

describe("measureDuplexIteration", () => {
  it("claims the outbound endpoint once a sampled envelope crosses the gate", () => {
    // Given: one sampled envelope exactly at the profile's byte gate.
    const measurement = measureDuplexIteration({
      accountCount: 48,
      profile: Profile,
      sampledByteSizes: [Profile.saturatedEnvelopeMinBytes],
      inboundAcceptedSwaps: 0,
      epochsSpanned: 1
    })

    // Then: only the measured (depot→outpost) direction is saturated.
    expect(measurement.saturatedEndpoints).toEqual([
      RunEvidenceEndpoint.DepotOutpostEthereum
    ])
    expect(measurement.outboundPeakBytes).toBe(
      Profile.saturatedEnvelopeMinBytes
    )
  })

  it("leaves the outbound endpoint unsaturated one byte below the gate", () => {
    // Given: a sample just under the gate.
    const measurement = measureDuplexIteration({
      accountCount: 48,
      profile: Profile,
      sampledByteSizes: [Profile.saturatedEnvelopeMinBytes - 1],
      inboundAcceptedSwaps: 0,
      epochsSpanned: 1
    })

    // Then: nothing is claimed.
    expect(measurement.saturatedEndpoints).toEqual([])
  })

  it("takes the PEAK of the sampled envelopes, not the last", () => {
    // Given: a large envelope followed by small ones.
    const measurement = measureDuplexIteration({
      accountCount: 48,
      profile: Profile,
      sampledByteSizes: [Profile.saturatedEnvelopeMinBytes, 10, 20],
      inboundAcceptedSwaps: 0,
      epochsSpanned: 1
    })

    // Then: the peak decides, so a post-burst lull cannot mask saturation.
    expect(measurement.outboundPeakBytes).toBe(
      Profile.saturatedEnvelopeMinBytes
    )
    expect(measurement.saturatedEndpoints).toContain(
      RunEvidenceEndpoint.DepotOutpostEthereum
    )
  })

  it("infers inbound saturation from accepted swaps per epoch", () => {
    // Given: enough accepted ETH→WIRE swaps inside a single epoch.
    const measurement = measureDuplexIteration({
      accountCount: 512,
      profile: Profile,
      sampledByteSizes: [],
      inboundAcceptedSwaps: SaturatingInboundSwaps,
      epochsSpanned: 1
    })

    // Then: the inferred (outpost→depot) direction is claimed on its own.
    expect(measurement.saturatedEndpoints).toEqual([
      RunEvidenceEndpoint.OutpostEthereumDepot
    ])
    expect(measurement.inboundAttestationsPerEpoch).toBe(SaturatingInboundSwaps)
  })

  it("divides the inbound load across the epochs the burst spanned", () => {
    // Given: the same swap count spread over four epochs.
    const measurement = measureDuplexIteration({
      accountCount: 512,
      profile: Profile,
      sampledByteSizes: [],
      inboundAcceptedSwaps: SaturatingInboundSwaps,
      epochsSpanned: 4
    })

    // Then: per-epoch density falls below the gate — load spread thin over
    // several epochs never fills a single epochIn.
    expect(measurement.inboundAttestationsPerEpoch).toBe(
      Math.floor(SaturatingInboundSwaps / 4)
    )
    expect(measurement.saturatedEndpoints).toEqual([])
  })

  it("claims BOTH endpoints when the two halves land together", () => {
    // Given: a cap-packed outbound envelope AND a full epoch of inbound swaps.
    const measurement = measureDuplexIteration({
      accountCount: 512,
      profile: Profile,
      sampledByteSizes: [Profile.saturatedEnvelopeMinBytes],
      inboundAcceptedSwaps: SaturatingInboundSwaps,
      epochsSpanned: 1
    })

    // Then: both required endpoints are saturated — the duplex condition the
    // campaign exists to produce.
    expect([...measurement.saturatedEndpoints].sort()).toEqual(
      [...DuplexRequiredEndpoints].sort()
    )
  })

  it("reports zero peak when nothing was sampled", () => {
    // Given: a burst during which no outbound envelope was observed.
    const measurement = measureDuplexIteration({
      accountCount: 12,
      profile: Profile,
      sampledByteSizes: [],
      inboundAcceptedSwaps: 0,
      epochsSpanned: 1
    })

    // Then: the peak is zero rather than -Infinity from an empty Math.max.
    expect(measurement.outboundPeakBytes).toBe(0)
    expect(measurement.outboundEnvelopeCount).toBe(0)
  })

  it("scales the inbound gate with the level", () => {
    // Given: a swap count that saturates the light level but not the heavy one.
    const light = LoadProfile.resolve({ level: LoadLevel.light }),
      heavy = LoadProfile.resolve({ level: LoadLevel.heavy }),
      swaps = Math.ceil(light.saturatedEnvelopeMinBytes / EstimatedAttestationBytes)

    // Then: a lighter level demands proportionally less applied load.
    expect(
      measureDuplexIteration({
        accountCount: 96,
        profile: light,
        sampledByteSizes: [],
        inboundAcceptedSwaps: swaps,
        epochsSpanned: 1
      }).saturatedEndpoints
    ).toContain(RunEvidenceEndpoint.OutpostEthereumDepot)
    expect(
      measureDuplexIteration({
        accountCount: 96,
        profile: heavy,
        sampledByteSizes: [],
        inboundAcceptedSwaps: swaps,
        epochsSpanned: 1
      }).saturatedEndpoints
    ).toEqual([])
  })
})

describe("startOutboundSampling", () => {
  it("accumulates distinct envelopes the one-deep table rotates past", async () => {
    // Given: a source whose single-tip table advances between reads — the real
    // `outenvelopes` behavior a single post-burst read would miss.
    const epochs = [
        recordOf(1, 100),
        recordOf(2, 9_000),
        recordOf(3, 250)
      ]
    let call = 0
    const source: EnvelopeRecordSource = {
        snapshot: async () => {
          const record = epochs[Math.min(call, epochs.length - 1)]
          call += 1
          return snapshotOf([record])
        }
      },
      sampler = startOutboundSampling(source, Profile)
    // Let the loop observe every distinct tip, then stop it.
    await new Promise(resolve =>
      setTimeout(resolve, OutboundSampleIntervalMs * 2 + 500)
    )
    sampler.stop()
    const collected = await sampler.collected()

    // Then: every rotated-past envelope is retained, so the peak is visible.
    expect(collected.length).toBeGreaterThanOrEqual(2)
    expect(Math.max(...collected)).toBe(9_000)
  }, 20_000)

  it("stops cleanly and survives a source that throws", async () => {
    // Given: a source that always fails.
    const source: EnvelopeRecordSource = {
        snapshot: async () => {
          throw new Error("rpc down")
        }
      },
      sampler = startOutboundSampling(source, Profile)
    sampler.stop()

    // Then: the sampler resolves empty rather than rejecting — a transient RPC
    // failure must not abort the burst it is observing.
    await expect(sampler.collected()).resolves.toEqual([])
  })

  it("resolves immediately when stopped before its first sample completes", async () => {
    // Given: a sampler stopped right away.
    const source: EnvelopeRecordSource = {
        snapshot: async () => snapshotOf([recordOf(1, 42)])
      },
      sampler = startOutboundSampling(source, Profile)
    sampler.stop()

    // Then: the in-flight read still lands and the loop exits without waiting
    // out another interval.
    await expect(sampler.collected()).resolves.toEqual([42])
  })
})
