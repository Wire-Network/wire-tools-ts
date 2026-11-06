import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { omit } from "lodash"
import type { ClusterConfig } from "@wireio/cluster-tool-shared"
import {
  AnvilProcess,
  ProcessManager
} from "@wireio/cluster-tool/cluster/processes"
import { BindConfigProvider } from "@wireio/cluster-tool/config"
import { Localhost } from "@wireio/cluster-tool/utils"
import { fixtureConfig, PersistedFixture } from "../../config/clusterConfigFixture.js"

describe("AnvilProcess", () => {
  let dir: string
  let manager: ProcessManager
  beforeAll(() => {
    dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "anvilproc-"))
    ProcessManager.setClusterPath(dir)
    manager = ProcessManager.get()
  })
  afterEach(async () => {
    await manager.stopAll()
  })
  afterAll(() => {
    Fs.rmSync(dir, { recursive: true, force: true })
  })

  it("builds the base anvil argv with host/port/chain-id", async () => {
    const process = await AnvilProcess.create(manager, { binary: "/bin/true" })
    expect(process.exe).toBe("/bin/true")
    expect(process.args).toEqual(
      expect.arrayContaining([
        "--host",
        "--port",
        "--chain-id",
        String(AnvilProcess.DefaultChainId)
      ])
    )
  })

  it("adds the run-phase finality flags only when set", async () => {
    const without = await AnvilProcess.create(manager, { binary: "/bin/true" })
    expect(without.args).not.toContain("--block-time")
    await manager.stopAll()

    const withFlags = await AnvilProcess.create(manager, {
      binary: "/bin/true",
      slotsInAnEpoch: AnvilProcess.SlotsInAnEpoch,
      blockTimeSec: AnvilProcess.BlockTimeSec
    })
    expect(withFlags.args).toEqual(
      expect.arrayContaining(["--slots-in-an-epoch", "--block-time"])
    )
  })

  it("always carries the mainnet-parity gas flags", async () => {
    // Unconditional, NOT run-phase-gated: the deploy phase must reject an
    // oversized transaction exactly as mainnet would, or a contract that can
    // never ship passes locally and fails only on a real chain.
    const process = await AnvilProcess.create(manager, { binary: "/bin/true" })
    expect(process.args).toEqual(
      expect.arrayContaining([
        "--hardfork",
        AnvilProcess.Hardfork,
        "--enable-tx-gas-limit",
        "--gas-limit",
        String(AnvilProcess.BlockGasLimit)
      ])
    )
  })

  it("never overrides the EVM code-size limit", async () => {
    // Same parity requirement as the gas flags, on code size: NO --code-size-limit
    // override, so the fork's default EIP-170 24KB rule applies and a cluster
    // deploy is real EIP-170 evidence. Re-adding the override would let an
    // unshippable contract deploy here and fail only on a real chain.
    const process = await AnvilProcess.create(manager, { binary: "/bin/true" })
    expect(process.args).not.toContain("--code-size-limit")
  })

  it("sizes the block gas limit above EIP-7825's per-transaction cap", async () => {
    // `--gas-limit` bounds the BLOCK; `--enable-tx-gas-limit` bounds a single
    // transaction at 2^24. A block limit at or below the per-tx cap would make
    // the block the binding constraint and mask which limit actually bit.
    expect(AnvilProcess.BlockGasLimit).toBeGreaterThan(2 ** 24)
  })

  it("dials loopback on the resolved (free) port", async () => {
    const process = await AnvilProcess.create(manager, { binary: "/bin/true" })
    expect(process.rpcUrl).toContain(Localhost)
    expect(process.rpcUrl).toMatch(/^http:\/\/.+:\d+$/)
  })

  /**
   * Every path that spawns or renders a cluster's anvil takes its options from
   * `optionsFor`, so the deploy spawn and a relaunch differ only in interval
   * mining, and the create path cannot again miss a flag the relaunch paths carry.
   */
  describe("optionsFor", () => {
    /** Stand-in binary for rendering an argv; nothing runs it. */
    const StandInBinary = "/bin/true"
    let config: ClusterConfig

    beforeAll(async () => {
      const port = await BindConfigProvider.findAvailable(BindConfigProvider.DefaultAnvil)
      config = fixtureConfig({
        dataPath: Path.join(dir, "data"),
        bind: { ...PersistedFixture.bind, anvil: { ...PersistedFixture.bind.anvil, port } }
      })
    })

    /** The argv a cluster's anvil runs with on `launch`. */
    function argvOf(launch: AnvilProcess.Launch): string[] {
      return AnvilProcess.buildArgs(
        AnvilProcess.resolveConfig(AnvilProcess.optionsFor(config, launch), {
          binary: StandInBinary,
          port: config.bind.anvil.port
        })
      )
    }

    it("derives the binding, the chain and the state file from the cluster config, and no binary", () => {
      const options = AnvilProcess.optionsFor(config, AnvilProcess.Launch.deploy)
      expect(options).toMatchObject({
        host: config.bind.anvil.address,
        port: config.bind.anvil.port,
        chainId: AnvilProcess.DefaultChainId,
        stateFile: Path.join(config.dataPath, AnvilProcess.StateSubpath, AnvilProcess.StateFilename)
      })
      expect(options.binary).toBeUndefined()
    })

    it("sets finality on both launches and interval mining on a relaunch only", () => {
      const deploy = AnvilProcess.optionsFor(config, AnvilProcess.Launch.deploy),
        relaunch = AnvilProcess.optionsFor(config, AnvilProcess.Launch.relaunch)
      expect(deploy.slotsInAnEpoch).toBe(AnvilProcess.SlotsInAnEpoch)
      expect(deploy.blockTimeSec).toBeUndefined()
      expect(relaunch.blockTimeSec).toBe(AnvilProcess.BlockTimeSec)
      expect(omit(relaunch, "blockTimeSec")).toEqual(deploy)
    })

    it("renders --slots-in-an-epoch on both launches and --block-time on a relaunch only", () => {
      expect(argvOf(AnvilProcess.Launch.deploy)).toContain("--slots-in-an-epoch")
      expect(argvOf(AnvilProcess.Launch.deploy)).not.toContain("--block-time")
      expect(argvOf(AnvilProcess.Launch.relaunch)).toEqual(
        expect.arrayContaining(["--slots-in-an-epoch", "--block-time"])
      )
    })
  })
})
