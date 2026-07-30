import { MaxEnvelopeBytes, SaturatedEnvelopeMinBytes } from "@wireio/test-opp-stress"

import { LoadLevel, LoadProfile } from "@wireio/opp-stress-harness"

describe("LoadProfile.resolve", () => {
  it("defaults to the moderate preset when no level is named", () => {
    // Given: no options at all.
    const profile = LoadProfile.resolve()

    // Then: the default level's preset is returned verbatim.
    expect(profile.level).toBe(LoadProfile.DefaultLevel)
    expect(profile.byteTargetRatio).toBe(
      LoadProfile.Presets[LoadProfile.DefaultLevel].byteTargetRatio
    )
    expect(profile.ramp).toEqual(
      LoadProfile.Presets[LoadProfile.DefaultLevel].ramp
    )
  })

  it("derives the absolute byte gate from the cap fraction", () => {
    // Given: the heavy preset at 0.75 of the cap.
    const profile = LoadProfile.resolve({ level: LoadLevel.heavy })

    // Then: the gate is the floored fraction of the protocol cap.
    expect(profile.saturatedEnvelopeMinBytes).toBe(
      Math.floor(MaxEnvelopeBytes * 0.75)
    )
  })

  it("reproduces the calibrated soak gate at the saturating level", () => {
    // Given: the level that mirrors the in-cluster flow campaign.
    const profile = LoadProfile.resolve({ level: LoadLevel.saturating })

    // Then: its gate is the engine's own 95%-of-cap constant, so a CLI run and
    // the flow campaign judge saturation identically.
    expect(profile.saturatedEnvelopeMinBytes).toBe(SaturatedEnvelopeMinBytes)
    expect(profile.ramp.initialCount).toBe(48)
    expect(profile.ramp.maxCount).toBe(512)
  })

  it("layers individual overrides over the named preset", () => {
    // Given: the heavy preset with two leaves overridden.
    const profile = LoadProfile.resolve({
      level: LoadLevel.heavy,
      byteTargetRatio: 0.5,
      ramp: { maxCount: 1_024 },
      workload: { concurrency: 32 }
    })

    // Then: overridden leaves win and every other leaf keeps the preset's.
    expect(profile.byteTargetRatio).toBe(0.5)
    expect(profile.ramp.maxCount).toBe(1_024)
    expect(profile.workload.concurrency).toBe(32)
    expect(profile.ramp.initialCount).toBe(
      LoadProfile.Presets[LoadLevel.heavy].ramp.initialCount
    )
    expect(profile.workload.swapsPerWallet).toBe(
      LoadProfile.Presets[LoadLevel.heavy].workload.swapsPerWallet
    )
  })

  it("treats an undefined override as absent", () => {
    // Given: overrides whose leaves are all undefined (the yargs no-flag shape).
    const profile = LoadProfile.resolve({
      level: LoadLevel.light,
      byteTargetRatio: undefined,
      ramp: { maxCount: undefined },
      workload: { concurrency: undefined }
    })

    // Then: the preset survives untouched.
    expect(profile.ramp).toEqual(LoadProfile.Presets[LoadLevel.light].ramp)
    expect(profile.workload).toEqual(
      LoadProfile.Presets[LoadLevel.light].workload
    )
  })

  it("rejects a byte target outside (0, 1]", () => {
    expect(() => LoadProfile.resolve({ byteTargetRatio: 0 })).toThrow(RangeError)
    expect(() => LoadProfile.resolve({ byteTargetRatio: 1.5 })).toThrow(
      RangeError
    )
    expect(() => LoadProfile.resolve({ byteTargetRatio: Number.NaN })).toThrow(
      RangeError
    )
  })

  it("accepts a byte target of exactly the full cap", () => {
    // Given: the boundary value.
    const profile = LoadProfile.resolve({ byteTargetRatio: 1 })

    // Then: the gate is the whole envelope cap.
    expect(profile.saturatedEnvelopeMinBytes).toBe(MaxEnvelopeBytes)
  })

  it("rejects a ramp override the engine considers invalid", () => {
    // Given: a ceiling below the preset's starting count.
    expect(() =>
      LoadProfile.resolve({ level: LoadLevel.heavy, ramp: { maxCount: 1 } })
    ).toThrow(RangeError)
    // And: a multiplier that would never advance the ramp.
    expect(() => LoadProfile.resolve({ ramp: { multiplier: 1 } })).toThrow(
      RangeError
    )
  })

  it("rejects a non-positive workload leaf", () => {
    expect(() => LoadProfile.resolve({ workload: { concurrency: 0 } })).toThrow(
      RangeError
    )
    expect(() =>
      LoadProfile.resolve({ workload: { swapsPerWallet: 1.5 } })
    ).toThrow(RangeError)
  })

  it("rejects an unknown level", () => {
    expect(() =>
      LoadProfile.resolve({ level: "extreme" as LoadLevel })
    ).toThrow(RangeError)
  })

  it("orders the presets by ascending intensity", () => {
    // Given: every preset in declared order.
    const levels = [
        LoadLevel.light,
        LoadLevel.moderate,
        LoadLevel.heavy,
        LoadLevel.saturating
      ],
      profiles = levels.map(level => LoadProfile.resolve({ level }))

    // Then: both the byte gate and the account ceiling climb monotonically —
    // the coupling that keeps each level's target reachable.
    profiles.slice(1).forEach((profile, index) => {
      expect(profile.saturatedEnvelopeMinBytes).toBeGreaterThan(
        profiles[index].saturatedEnvelopeMinBytes
      )
      expect(profile.ramp.maxCount).toBeGreaterThanOrEqual(
        profiles[index].ramp.maxCount
      )
    })
  })
})
