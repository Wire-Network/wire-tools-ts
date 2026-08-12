import {
  LoadLevel,
  LoadProfile,
  MaxEnvelopeBytes,
  SaturatedEnvelopeMinBytes
} from "@wireio/test-flow-swap-stress-saturation/stress-engine/index.js"


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
        LoadLevel.smoke,
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

describe("LoadProfile.resolveLevel", () => {
  it("returns the caller's fallback when the variable is unset", () => {
    // Given: an environment naming no level.
    // Then: each consumer's own historical default survives — the flow passes
    // `saturating` so an untouched environment reproduces its calibrated soak.
    expect(LoadProfile.resolveLevel({}, LoadLevel.saturating)).toBe(
      LoadLevel.saturating
    )
    expect(LoadProfile.resolveLevel({})).toBe(LoadProfile.DefaultLevel)
  })

  it("treats an empty or whitespace value as unset", () => {
    const environment = { [LoadProfile.LevelEnvVar]: "   " }
    expect(LoadProfile.resolveLevel(environment, LoadLevel.heavy)).toBe(
      LoadLevel.heavy
    )
  })

  it("reads every named level, tolerating surrounding whitespace", () => {
    Object.values(LoadLevel).forEach(level => {
      expect(
        LoadProfile.resolveLevel({ [LoadProfile.LevelEnvVar]: ` ${level} ` })
      ).toBe(level)
    })
  })

  it("THROWS on an unrecognised level rather than falling back", () => {
    // A typo silently running a 512-account soak in CI is precisely the
    // failure this control exists to prevent, so it must fail loudly.
    expect(() =>
      LoadProfile.resolveLevel({ [LoadProfile.LevelEnvVar]: "lite" })
    ).toThrow(RangeError)
  })

  it("lets an explicit option beat the environment", () => {
    const profile = LoadProfile.resolveFromEnvironment({
      level: LoadLevel.light
    })
    expect(profile.level).toBe(LoadLevel.light)
  })
})

describe("LoadProfile.iterationCount", () => {
  it("counts the doubling steps up to the ceiling", () => {
    // 48 -> 96 -> 192 -> 384 -> 512(clamped) is the calibrated soak's 5.
    expect(
      LoadProfile.iterationCount(LoadProfile.Presets[LoadLevel.saturating].ramp)
    ).toBe(5)
    // 12 -> 24 -> 48 -> 96 -> 128(clamped) is light's 5.
    expect(
      LoadProfile.iterationCount(LoadProfile.Presets[LoadLevel.light].ramp)
    ).toBe(5)
  })

  it("clamps light's top rung to the ceiling instead of doubling past it", () => {
    // The 128 ceiling is deliberate: 96 accounts miss the saturation gate by
    // ~4%, and the natural next double (192) is where the phase-1 payout
    // stalls. The clamp is what makes an intermediate top rung expressible.
    expect(
      LoadProfile.accountCurve(LoadProfile.Presets[LoadLevel.light].ramp)
    ).toEqual([12, 24, 48, 96, 128])
  })

  it("returns one when the ramp starts at its ceiling", () => {
    expect(
      LoadProfile.iterationCount({
        initialCount: 64,
        multiplier: 2,
        maxCount: 64,
        phaseTimeoutMs: 1_000
      })
    ).toBe(1)
  })

  it("terminates on a ceiling that is not a clean power of the multiplier", () => {
    // 10 -> 30 -> 90 -> 100(clamped) — the clamp must still converge.
    expect(
      LoadProfile.iterationCount({
        initialCount: 10,
        multiplier: 3,
        maxCount: 100,
        phaseTimeoutMs: 1_000
      })
    ).toBe(4)
  })
})

describe("LoadProfile smoke preset", () => {
  it("bounds the campaign to a short epoch window", () => {
    // Given: the gate preset.
    const profile = LoadProfile.resolve({ level: LoadLevel.smoke }),
      iterations = LoadProfile.iterationCount(profile.ramp),
      phasesPerIteration = 2,
      campaignCeilingMs =
        profile.ramp.phaseTimeoutMs * iterations * phasesPerIteration

    // Then: two rungs and a ~8 minute ceiling. This is the load-bearing
    // property — the r8 run showed the Ethereum outbound delivery reverting
    // once an outbound BACKLOG accumulates (ETH-241), which is driven by
    // epochs elapsed rather than ramp size, so the campaign must CONCLUDE
    // early rather than merely run small.
    expect(iterations).toBe(2)
    expect(campaignCeilingMs).toBeLessThanOrEqual(600_000)
  })

  it("sets a byte gate above an idle envelope but within observed load", () => {
    // Given: r8 measured ~698-byte idle envelopes and 2.7-4.5 KB under load.
    const IdleEnvelopeBytes = 698,
      ObservedLoadedBytes = 2_755,
      profile = LoadProfile.resolve({ level: LoadLevel.smoke })

    // Then: the gate discriminates real attestation packing from an idle
    // envelope, while staying inside what this workload actually produces.
    expect(profile.saturatedEnvelopeMinBytes).toBeGreaterThan(IdleEnvelopeBytes)
    expect(profile.saturatedEnvelopeMinBytes).toBeLessThan(ObservedLoadedBytes)
  })

  it("is the least intense preset", () => {
    const smoke = LoadProfile.resolve({ level: LoadLevel.smoke }),
      light = LoadProfile.resolve({ level: LoadLevel.light })
    expect(smoke.saturatedEnvelopeMinBytes).toBeLessThan(
      light.saturatedEnvelopeMinBytes
    )
    expect(smoke.ramp.maxCount).toBeLessThan(light.ramp.maxCount)
  })
})
