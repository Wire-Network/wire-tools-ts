import { match } from "ts-pattern"

import { MaxEnvelopeBytes } from "./envelopeMetricTypes.js"
import { assertRampConfig } from "./rampCurve.js"
import type { OppStressRampConfig } from "./rampCurve.js"

/**
 * Named stress intensity presets.
 *
 * A level answers two coupled questions at once: how full an OPP envelope must
 * get before the campaign calls itself saturated (the byte target), and how
 * aggressively the ramp climbs to get there (the account curve). They are
 * coupled because the byte target is only reachable at a matching account
 * count — ~300-byte attestations need ~210 landing in one epoch per direction
 * to fill the 64KB cap — so raising one without the other yields a ramp that
 * can never satisfy its own criterion.
 */
export enum LoadLevel {
  smoke = "smoke",
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
 * run ~300 bytes, 48 accounts peaked at 14.8KB (23% of the cap), 48 and 96
 * accounts ran clean, and 192 wedged the Ethereum outpost (ETH-241).
 */
export namespace LoadProfile {
  /**
   * Level used when a caller names none and supplies no other fallback.
   *
   * Deliberately mid-range: each consumer declares the fallback that preserves
   * ITS behaviour instead of inheriting one. `flow-swap-stress-saturation`
   * passes `saturating` explicitly, so an unset environment reproduces its
   * calibrated soak byte-for-byte.
   */
  export const DefaultLevel = LoadLevel.moderate
  /**
   * Environment variable naming the active level.
   *
   * UNIFORM across every consumer — the e2e gate sets it once in shared job
   * env for all flows, never per-flow (see
   * `e2e-tests-no-per-flow-env-customization.md`). Mirrors the
   * `WIRE_FLOW_TIMEOUT_SCALE` precedent: an explicit operator override that no
   * code derives.
   */
  export const LevelEnvVar = "WIRE_STRESS_LOAD_LEVEL"
  /** Byte target must stay above zero — a zero gate is saturated by any envelope. */
  export const MinimumByteTargetRatio = 0
  /** Byte target cannot exceed the protocol cap. */
  export const MaximumByteTargetRatio = 1

  /**
   * The four named presets.
   *
   * `saturating` reproduces the calibrated soak the flow campaign runs (0.95 of
   * the cap, 48→512 doubling, 480s phases) so a CLI run and the in-cluster flow
   * measure the same thing; the lighter levels lower BOTH the gate and the
   * curve together so each remains reachable. `light` stays entirely inside the
   * account range r7 proved clean, which is what makes it safe for a per-PR
   * gate while ETH-241 is open.
   */
  export const Presets: Readonly<Record<LoadLevel, LoadLevelPreset>> = {
    /**
     * Per-PR gate preset. Sized for EPOCHS ELAPSED, not accounts.
     *
     * The r8 live run (2026-07-30) showed the Ethereum outbound delivery
     * reverting at `eth_estimateGas` once a backlog accumulates: `OPPInbound`
     * failed on a 3,453-byte inbound envelope at epoch 22 — matching ETH-241's
     * characterization (a ~3.4 KB inbound envelope plus a backlogged outbound
     * queue needs ~93.6M gas against a 30M block limit). The trigger is the
     * accumulated OUTBOUND queue, largely independent of ramp size, so a
     * smaller ramp does not dodge it — only a SHORTER one does.
     *
     * Two rungs and a 120s phase ceiling bound the campaign to ~8 minutes so it
     * concludes well before the backlog reaches the gas ceiling. The 2% byte
     * target is deliberately modest: idle envelopes run ~698 bytes and loaded
     * ones reached 2.7–4.5 KB in r8, so a 1,310-byte gate still requires real
     * attestation packing while staying reachable. This is a CIRCULATION check,
     * not a saturation measurement — use `saturating` for the real soak.
     */
    [LoadLevel.smoke]: {
      byteTargetRatio: 0.02,
      ramp: {
        initialCount: 8,
        multiplier: 2,
        maxCount: 16,
        phaseTimeoutMs: 120_000
      },
      workload: { swapsPerWallet: 1, concurrency: 4 }
    },
    /**
     * Ramps to 128 accounts (12 → 24 → 48 → 96 → 128), NOT the natural 192.
     *
     * At 96 the depot→Ethereum direction peaks around 15.7 KB against a
     * 16,384-byte gate — a genuine campaign that misses saturation by ~4%. The
     * top rung exists to clear that bar with real traffic rather than by
     * lowering it.
     *
     * 128 rather than 192 for a measured reason: 192 accounts is where the
     * phase-1 WIRE payout stalls outright (846s producing ZERO payouts, while
     * 12–96 settle in 215–290s). Doubling would trade a saturation miss for a
     * payout failure. 128 sits a third below that cliff.
     *
     * The sizing is interpolated from two live measurements of the SAME
     * quantity (96 → 15,658 bytes, 192 → 25,180), which is legitimate because
     * envelope size tracks ACCOUNT COUNT, not concurrency: light (concurrency
     * 4) and moderate (concurrency 8) both peaked at exactly 15,658 at 96
     * accounts. The fit puts 128 near 19 KB, ~16% clear of the gate.
     */
    [LoadLevel.light]: {
      byteTargetRatio: 0.25,
      ramp: {
        initialCount: 12,
        multiplier: 2,
        maxCount: 128,
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
    const {
        level = DefaultLevel,
        ramp: rampOverrides = {},
        workload: workloadOverrides = {}
      } = options,
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
   * Resolve the active level from the environment.
   *
   * An unset variable yields {@link DefaultLevel}, so an untouched environment
   * reproduces the calibrated soak. An UNRECOGNISED value THROWS rather than
   * falling back: a typo'd level silently running a 512-account soak in CI is
   * exactly the failure this control exists to prevent.
   *
   * @param environment Environment to read; defaults to `process.env`.
   * @param fallback Level to use when unset — each consumer passes the one
   *   that preserves its own historical behaviour.
   * @returns The named level, or `fallback` when unset/empty.
   */
  export function resolveLevel(
    environment: NodeJS.ProcessEnv = process.env,
    fallback: LoadLevel = DefaultLevel
  ): LoadLevel {
    const raw = environment[LevelEnvVar]
    if (raw === undefined || raw.trim().length === 0) return fallback
    const named = raw.trim()
    return match(named)
      .with(LoadLevel.smoke, () => LoadLevel.smoke)
      .with(LoadLevel.light, () => LoadLevel.light)
      .with(LoadLevel.moderate, () => LoadLevel.moderate)
      .with(LoadLevel.heavy, () => LoadLevel.heavy)
      .with(LoadLevel.saturating, () => LoadLevel.saturating)
      .otherwise(() => {
        throw new RangeError(
          `${LevelEnvVar} must be one of ${Object.values(LoadLevel).join(" | ")}; got ${named}`
        )
      })
  }

  /**
   * Resolve the profile named by the environment, with overrides layered on.
   *
   * @param options Overrides applied over the environment's level.
   * @returns The resolved profile, validated.
   */
  export function resolveFromEnvironment(
    options: LoadProfileOptions = {}
  ): LoadProfile {
    const { level = resolveLevel() } = options
    return resolve({ ...options, level })
  }

  /**
   * Iterations a ramp performs before reaching its ceiling.
   *
   * The campaign's funding, provisioning, and deadline math all scale off this,
   * so it is DERIVED from the curve rather than tracked as a separate constant
   * that could drift out of step with it.
   *
   * @param ramp Account curve to walk.
   * @returns Iteration count, always at least one.
   */
  export function iterationCount(ramp: OppStressRampConfig): number {
    return accountCurve(ramp).length
  }

  /**
   * The ramp's account curve — every rung's account count, in order.
   *
   * The curve is fully determined by the profile, so an orchestrator can build
   * one Phase per rung at PLAN time instead of discovering the rungs at run
   * time. {@link iterationCount} is derived from this, so the two can never
   * disagree.
   *
   * @param ramp Account curve to walk.
   * @returns Account count per rung, always at least one entry.
   */
  export function accountCurve(ramp: OppStressRampConfig): readonly number[] {
    const counts = [ramp.initialCount]
    let accounts = ramp.initialCount
    while (accounts < ramp.maxCount) {
      accounts = Math.min(accounts * ramp.multiplier, ramp.maxCount)
      counts.push(accounts)
    }
    return counts
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
