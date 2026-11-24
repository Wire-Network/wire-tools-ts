import Path from "node:path"
import type { ClusterBuildOptions } from "@wireio/cluster-tool/config"
import { ClusterBuildDefaults, Steps } from "@wireio/cluster-tool/orchestration"
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

  it("mirrors the contract's ceilings for the percent rail", () => {
    expect(ClusterBuildDefaults.MaxTerminateMinimumPercentSamples).toBe(
      ContractMaximumMinimumPercentSamples
    )
    expect(ClusterBuildDefaults.MaxTerminateMaxPercentMisses24h).toBe(
      ContractMaximumPercentMisses
    )
  })
})
