import {
  assertRampConfig,
  MaxEnvelopeBytes,
  type OppStressRampConfig
} from "@wireio/test-opp-stress"

/**
 * Named stress intensity presets.
 *
 * A level answers two coupled questions at once: how full an OPP envelope must
 * get before the campaign calls itself saturated (the byte target), and how
 * aggressively the ramp climbs to get there (the account curve). They are
 * coupled because the byte target is only reachable at a matching account
 * count — ~300-byte attestations need ~210 landing in one epoch per direction
 * to fill the 64KB cap.
 */
export enum LoadLevel {
  light = "light",
  moderate = "moderate",
  heavy = "heavy",
  saturating = "saturating"
}

/** Per-direction workload shape driven at one ramp iteration. */
export interface LoadWorkload {
  /** Swaps each wallet performs per iteration. */
  readonly swapsPerWallet: number
  /** Maximum swaps in flight at once, per direction. */
  readonly concurrency: number
}

/** The static shape a {@link LoadLevel} names, before overrides are layered on. */
export interface LoadLevelPreset {
  /** Fraction of {@link MaxEnvelopeBytes} treated as the saturation target. */
  readonly byteTargetRatio: number
  /** Account curve the ramp climbs. */
  readonly ramp: OppStressRampConfig
  /** Per-direction workload at each iteration. */
  readonly workload: LoadWorkload
}

/** A fully resolved load profile — a preset with every override applied. */
export interface LoadProfile {
  /** Preset the profile started from. */
  readonly level: LoadLevel
  /** Fraction of {@link MaxEnvelopeBytes} treated as the saturation target. */
  readonly byteTargetRatio: number
  /** Absolute byte gate derived from {@link byteTargetRatio}. */
  readonly saturatedEnvelopeMinBytes: number
  /** Account curve the ramp climbs. */
  readonly ramp: OppStressRampConfig
  /** Per-direction workload at each iteration. */
  readonly workload: LoadWorkload
}

/** Caller overrides layered over a named preset; every field optional. */
export interface LoadProfileOptions {
  /** Preset to start from; defaults to {@link LoadProfile.DefaultLevel}. */
  readonly level?: LoadLevel
  /** Overrides the preset's byte target ratio. */
  readonly byteTargetRatio?: number
  /** Overrides individual ramp leaves; unset leaves keep the preset's. */
  readonly ramp?: Partial<OppStressRampConfig>
  /** Overrides individual workload leaves; unset leaves keep the preset's. */
  readonly workload?: Partial<LoadWorkload>
}

/**
 * Preset table and resolution for {@link LoadProfile}.
 *
 * Sizing is calibrated against the 2026-07-24/25 r5–r7 live runs: attestations
 * run ~300 bytes, 48 accounts peaked at 14.8KB (23% of the cap), and the byte
 * gate is expected to trip near 384 accounts on the Ethereum directions.
 */
export namespace LoadProfile {
  /** Level used when the caller names none. */
  export const DefaultLevel = LoadLevel.moderate
  /** Byte target must stay above zero — a zero gate is saturated by any envelope. */
  export const MinimumByteTargetRatio = 0
  /** Byte target cannot exceed the protocol cap. */
  export const MaximumByteTargetRatio = 1

  /**
   * The four named presets.
   *
   * `saturating` reproduces the calibrated soak the flow campaign runs (0.95 of
   * the cap, 48→512 doubling) so a CLI run and the in-cluster flow measure the
   * same thing; the lighter levels lower BOTH the gate and the curve together
   * so each remains reachable.
   */
  export const Presets: Readonly<Record<LoadLevel, LoadLevelPreset>> = {
    [LoadLevel.light]: {
      byteTargetRatio: 0.25,
      ramp: {
        initialCount: 12,
        multiplier: 2,
        maxCount: 96,
        phaseTimeoutMs: 240_000
      },
      workload: { swapsPerWallet: 1, concurrency: 4 }
    },
    [LoadLevel.moderate]: {
      byteTargetRatio: 0.5,
      ramp: {
        initialCount: 24,
        multiplier: 2,
        maxCount: 192,
        phaseTimeoutMs: 360_000
      },
      workload: { swapsPerWallet: 1, concurrency: 8 }
    },
    [LoadLevel.heavy]: {
      byteTargetRatio: 0.75,
      ramp: {
        initialCount: 48,
        multiplier: 2,
        maxCount: 384,
        phaseTimeoutMs: 480_000
      },
      workload: { swapsPerWallet: 1, concurrency: 12 }
    },
    [LoadLevel.saturating]: {
      byteTargetRatio: 0.95,
      ramp: {
        initialCount: 48,
        multiplier: 2,
        maxCount: 512,
        phaseTimeoutMs: 480_000
      },
      workload: { swapsPerWallet: 2, concurrency: 16 }
    }
  }

  /**
   * Resolve a preset with caller overrides layered on top.
   *
   * @param options Level selection plus any individual leaf overrides.
   * @returns The resolved profile, validated.
   */
  export function resolve(options: LoadProfileOptions = {}): LoadProfile {
    const { level = DefaultLevel, ramp: rampOverrides = {}, workload: workloadOverrides = {} } =
        options,
      preset = Presets[level]
    if (preset === undefined)
      throw new RangeError(`unknown load level: ${String(level)}`)
    const { byteTargetRatio = preset.byteTargetRatio } = options,
      {
        initialCount = preset.ramp.initialCount,
        multiplier = preset.ramp.multiplier,
        maxCount = preset.ramp.maxCount,
        phaseTimeoutMs = preset.ramp.phaseTimeoutMs
      } = rampOverrides,
      {
        swapsPerWallet = preset.workload.swapsPerWallet,
        concurrency = preset.workload.concurrency
      } = workloadOverrides,
      ramp: OppStressRampConfig = {
        initialCount,
        multiplier,
        maxCount,
        phaseTimeoutMs
      }
    assertByteTargetRatio(byteTargetRatio)
    assertRampConfig(ramp)
    assertWorkload({ swapsPerWallet, concurrency })
    return {
      level,
      byteTargetRatio,
      saturatedEnvelopeMinBytes: toSaturatedEnvelopeMinBytes(byteTargetRatio),
      ramp,
      workload: { swapsPerWallet, concurrency }
    }
  }

  /**
   * Convert a cap fraction into the absolute byte gate the metrics layer uses.
   *
   * @param byteTargetRatio Fraction of {@link MaxEnvelopeBytes} to target.
   * @returns Floored absolute byte count.
   */
  export function toSaturatedEnvelopeMinBytes(byteTargetRatio: number): number {
    return Math.floor(MaxEnvelopeBytes * byteTargetRatio)
  }

  /**
   * Validate a byte target ratio lies in `(0, 1]`.
   *
   * @param byteTargetRatio Fraction of the envelope cap to target.
   */
  export function assertByteTargetRatio(byteTargetRatio: number): void {
    if (
      !Number.isFinite(byteTargetRatio) ||
      byteTargetRatio <= MinimumByteTargetRatio ||
      byteTargetRatio > MaximumByteTargetRatio
    )
      throw new RangeError(
        `byteTargetRatio must be within (${MinimumByteTargetRatio}, ${MaximumByteTargetRatio}]`
      )
  }

  /**
   * Validate a workload's per-iteration counts are positive integers.
   *
   * @param workload Swap and concurrency counts to check.
   */
  export function assertWorkload(workload: LoadWorkload): void {
    if (!positiveInteger(workload.swapsPerWallet))
      throw new RangeError("swapsPerWallet must be a positive integer")
    if (!positiveInteger(workload.concurrency))
      throw new RangeError("concurrency must be a positive integer")
  }

  function positiveInteger(value: number): boolean {
    return Number.isInteger(value) && value > 0
  }
}
