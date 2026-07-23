import Path from "node:path"
import { PublicKey } from "@solana/web3.js"
import { OppSolProgram } from "@wireio/cluster-tool/orchestration"

describe("OppSolProgram.clusterDeployerKeypairFile", () => {
  it("joins the deployer keypair basename under the cluster data dir", () => {
    const dataPath = Path.join("/tmp", "cluster-x", "data")
    expect(OppSolProgram.clusterDeployerKeypairFile(dataPath)).toBe(
      Path.join(dataPath, OppSolProgram.deployerKeypairFilename)
    )
  })

  it("uses the documented `sol-deployer-keypair.json` basename", () => {
    expect(OppSolProgram.deployerKeypairFilename).toBe(
      "sol-deployer-keypair.json"
    )
    expect(Path.basename(OppSolProgram.clusterDeployerKeypairFile("/d"))).toBe(
      "sol-deployer-keypair.json"
    )
  })
})

describe("OppSolProgram epoch-warp constants", () => {
  it("warps to a slot that lands inside epoch 3 (not epoch 4+)", () => {
    // flush_staking_yield requires Clock.epoch >= 3, but a single-node
    // test-validator can only build epoch 3's leader schedule from genesis
    // stakes — warping into epoch 4+ leaves it unable to produce blocks. The
    // target MUST satisfy floor(warpSlot / slotsPerEpoch) === 3.
    const slotsPerEpoch = Number(OppSolProgram.solanaWarpSlotsPerEpoch),
      warpSlot = Number(OppSolProgram.solanaWarpSlot)
    expect(Math.floor(warpSlot / slotsPerEpoch)).toBe(3)
    // ...and it must be at/after the epoch-3 boundary (3 * 4096 = 12288).
    expect(warpSlot).toBeGreaterThanOrEqual(3 * slotsPerEpoch)
  })
})

describe("OppSolProgram address constants", () => {
  it("global_config seed matches the on-chain `has_one = admin` PDA seed", () => {
    expect(OppSolProgram.globalConfigSeed).toBe("global_config")
  })

  it("bpfLoaderUpgradeableProgramId is a well-formed base58 program id", () => {
    // Constructing a PublicKey throws on a malformed base58 address, so this
    // pins the hardcoded upgradeable-loader id as a valid 32-byte key.
    expect(
      () => new PublicKey(OppSolProgram.bpfLoaderUpgradeableProgramId)
    ).not.toThrow()
  })
})
