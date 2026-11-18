import type { ClusterConfig } from "@wireio/cluster-tool-shared"
import { Constants } from "@wireio/cluster-tool/Constants"
import { ClusterConfigGenesisRenderer } from "@wireio/cluster-tool/config/renderers"

describe("ClusterConfigGenesisRenderer", () => {
  /** A config carrying only what the genesis renderer reads. */
  function config(initialFinalizerKey: string = null): ClusterConfig {
    return {
      initialKey: Constants.DEV_K1_PUBLIC_KEY,
      initialFinalizerKey
    } as ClusterConfig
  }

  it("renders the authority depth the authority audit walks", () => {
    const genesis = JSON.parse(new ClusterConfigGenesisRenderer(config()).render())
    expect(genesis.initial_configuration.max_authority_depth).toBe(
      Constants.MAX_AUTHORITY_DEPTH
    )
    expect(genesis.initial_key).toBe(Constants.DEV_K1_PUBLIC_KEY)
    expect(genesis).not.toHaveProperty("initial_finalizer_key")
  })

  it("carries the finalizer key when the config has one", () => {
    const genesis = JSON.parse(
      new ClusterConfigGenesisRenderer(config(Constants.DEV_BLS_PUBLIC_KEY)).render()
    )
    expect(genesis.initial_finalizer_key).toBe(Constants.DEV_BLS_PUBLIC_KEY)
  })
})
