import Path from "node:path"
import {
  OutpostChainCodename,
  createUniformOutpostEpochDurations,
  type ClusterConfig
} from "@wireio/cluster-tool-shared"
import type { ClusterBuildOptions } from "@wireio/cluster-tool/config"
import { ClusterBuildDefaults, Steps } from "@wireio/cluster-tool/orchestration"
import { PersistedFixture } from "../config/clusterConfigFixture.js"
import {
  fixtureResolveEnvironment,
  type ResolveEnvironment
} from "../config/resolveEnvironmentFixture.js"

/** The contract's `DEFAULT_TERMINATE_MIN_PCT_SAMPLES`: 100 / the 5 % default threshold. */
const ContractDefaultMinimumPercentSamples = 20
/** The contract's `MAX_TERMINATE_MIN_PCT_SAMPLES`: 100 / the 1 % lowest threshold. */
const ContractMaximumMinimumPercentSamples = 100
/** The contract's `MAX_TERMINATE_MAX_PCT_MISSES_24H`. */
const ContractMaximumPercentMisses = 99
/** A 60 s epoch with the default three groups: a resident operator is on duty every 180 s. */
const DutyIntervalMs = 3 * 60 * 1_000
/** An hourly epoch: with three groups, eight duties fit the default 24 h window. */
const HourlyEpochDurationSec = 3_600

/** The persisted fixture (60 s epochs, three groups), reshaped for a case. Pure — no `resolve`. */
function config(overrides: Partial<ClusterConfig>): ClusterConfig {
  return { ...PersistedFixture, ...overrides }
}

describe("ClusterBuildDefaults — sysio.opreg termination rails", () => {
  let environment: ResolveEnvironment

  beforeEach(() => {
    environment = fixtureResolveEnvironment("termination-config-")
  })

  afterEach(() => {
    jest.restoreAllMocks()
    environment.cleanup()
  })

  /** Compose the real bootstrap over `options` and return its `opreg::setconfig` data. */
  async function setconfigData(options: ClusterBuildOptions = {}) {
    const plan = jest.spyOn(Steps.contracts.sysio.opreg, "planSetconfig")
    await ClusterBuildDefaults.create({
      clusterPath: Path.join(environment.rootPath, "cluster"),
      buildPath: environment.buildPath,
      ethereumPath: "/fake/eth",
      solanaPath: "/fake/sol",
      ...options
    })
    expect(plan).toHaveBeenCalledTimes(1)
    return plan.mock.calls[0][4]
  }

  it("installs the contract's default percent-rail sample when the cluster sets none", async () => {
    const data = await setconfigData()
    expect(data.terminate_min_pct_samples).toBe(
      ContractDefaultMinimumPercentSamples
    )
    expect(data.terminate_max_consecutive_misses).toBe(5)
    expect(data.terminate_max_pct_misses_24h).toBe(5)
    expect(data.terminate_window_ms).toBe(86_400_000)
  })

  it("installs a cluster's percent-rail sample beside its other rail overrides", async () => {
    const data = await setconfigData({
      terminateMaxConsecutiveMisses: 2,
      terminateMaxPercentMisses24h: 50,
      terminateMinimumPercentSamples: 2,
      terminateWindowMs: 3_600_000
    })
    expect(data.terminate_min_pct_samples).toBe(2)
    expect(data.terminate_max_consecutive_misses).toBe(2)
    expect(data.terminate_max_pct_misses_24h).toBe(50)
    expect(data.terminate_window_ms).toBe(3_600_000)
  })

  it("passes the lowest accepted sample through rather than reading it as unset", async () => {
    const data = await setconfigData({ terminateMinimumPercentSamples: 1 })
    expect(data.terminate_min_pct_samples).toBe(1)
  })

  it("refuses, before anything runs, a schedule whose window cannot reach the sample minimum", async () => {
    await expect(
      setconfigData({
        outpostEpochDurationSec: {
          [OutpostChainCodename.ETHEREUM]: HourlyEpochDurationSec
        }
      })
    ).rejects.toThrow(
      /holds 8 duty rotations of the ETHEREUM schedule .*terminate_min_pct_samples \(20\)/
    )
  })

  it("mirrors the contract's ceilings for the percent rail", () => {
    expect(ClusterBuildDefaults.MaxTerminateMinimumPercentSamples).toBe(
      ContractMaximumMinimumPercentSamples
    )
    expect(ClusterBuildDefaults.MaxTerminateMaxPercentMisses24h).toBe(
      ContractMaximumPercentMisses
    )
  })
})

describe("ClusterBuildDefaults.assertTerminationWindow — the window holds the percent rail's sample at every schedule", () => {
  it("accepts the default rails at the default schedules", () => {
    expect(() =>
      ClusterBuildDefaults.assertTerminationWindow(config({}))
    ).not.toThrow()
  })

  it("accepts a window of exactly the sample minimum's duty rotations and refuses one ms less", () => {
    const window = ContractDefaultMinimumPercentSamples * DutyIntervalMs
    expect(() =>
      ClusterBuildDefaults.assertTerminationWindow(
        config({ terminateWindowMs: window })
      )
    ).not.toThrow()
    expect(() =>
      ClusterBuildDefaults.assertTerminationWindow(
        config({ terminateWindowMs: window - 1 })
      )
    ).toThrow(
      /holds 19 duty rotations .*fewer than terminate_min_pct_samples \(20\)/
    )
  })

  it("accepts a window short of the consecutive-miss run: that rail counts misses whatever their age", () => {
    const window = 6 * DutyIntervalMs - 1
    expect(() =>
      ClusterBuildDefaults.assertTerminationWindow(
        config({ terminateWindowMs: window, terminateMinimumPercentSamples: 5 })
      )
    ).not.toThrow()
    expect(() =>
      ClusterBuildDefaults.assertTerminationWindow(
        config({ terminateWindowMs: window, terminateMinimumPercentSamples: 6 })
      )
    ).toThrow(
      /holds 5 duty rotations .*fewer than terminate_min_pct_samples \(6\)/
    )
  })

  it("checks every chain's own schedule", () => {
    expect(() =>
      ClusterBuildDefaults.assertTerminationWindow(
        config({
          outpostEpochDurationSec: {
            ...createUniformOutpostEpochDurations(60),
            [OutpostChainCodename.SOLANA]: HourlyEpochDurationSec
          }
        })
      )
    ).toThrow(/the SOLANA schedule \(3 groups of 3600 s epochs\)/)
  })

  it("accepts a sample minimum the hourly schedule's window holds", () => {
    expect(() =>
      ClusterBuildDefaults.assertTerminationWindow(
        config({
          outpostEpochDurationSec: createUniformOutpostEpochDurations(
            HourlyEpochDurationSec
          ),
          terminateMinimumPercentSamples: 8
        })
      )
    ).not.toThrow()
  })
})
