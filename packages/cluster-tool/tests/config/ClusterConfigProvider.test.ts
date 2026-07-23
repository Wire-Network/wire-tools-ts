import Fs from "node:fs"
import Net from "node:net"
import Os from "node:os"
import Path from "node:path"
import { SignatureProviderType } from "@wireio/cluster-tool-shared"
import { KeyType } from "@wireio/sdk-core"

/** An OS-free TCP port (not tracked by the bind registry) to pin in a test. */
function freeTcpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = Net.createServer()
    server.once("error", reject)
    server.listen(0, () => {
      const port = (server.address() as Net.AddressInfo).port
      server.close(() => resolve(port))
    })
  })
}
import {
  BindConfigProvider,
  ClusterConfigProvider
} from "@wireio/cluster-tool/config"
import { fixtureConfig, PersistedFixture } from "./clusterConfigFixture.js"

describe("ClusterConfigProvider", () => {
  describe("resolve", () => {
    it("fails fast when buildPath is missing", async () => {
      await expect(
        ClusterConfigProvider.resolve({
          clusterPath: "/c",
          ethereumPath: "/e",
          solanaPath: "/s"
        })
      ).rejects.toThrow(/buildPath is required/)
    })
    it("fails fast when clusterPath is missing", async () => {
      await expect(
        ClusterConfigProvider.resolve({
          buildPath: "/b",
          ethereumPath: "/e",
          solanaPath: "/s"
        })
      ).rejects.toThrow(/clusterPath is required/)
    })
  })

  describe("deserialize", () => {
    it("rehydrates the persisted topology as the plain ClusterConfig shape", () => {
      const cfg = fixtureConfig()
      expect(cfg.bind.nodeop.ports.batch).toHaveLength(3)
      expect(cfg.bind.nodeop.ports.bios.http).toBe(
        BindConfigProvider.DefaultBiosHttp
      )
      expect(cfg.epochDurationSec).toBe(60)
      // Plain data end-to-end — BindConfigProvider owns behavior over the shape.
      expect(BindConfigProvider.allPorts(cfg.bind).length).toBeGreaterThan(0)
    })
  })

  describe("derived paths", () => {
    it("ethereumDeploymentsPath is per-cluster (under dataPath)", () => {
      const cfg = fixtureConfig()
      expect(ClusterConfigProvider.ethereumDeploymentsPath(cfg)).toBe(
        `${cfg.dataPath}/ethereum-deployments`
      )
    })
  })

  describe("serialize / deserialize round-trip", () => {
    it("preserves every scalar field", () => {
      const cfg = fixtureConfig()
      const round = ClusterConfigProvider.deserialize(
        ClusterConfigProvider.serialize(cfg)
      )
      expect(round.buildPath).toBe(PersistedFixture.buildPath)
      expect(round.producerCount).toBe(PersistedFixture.producerCount)
      expect(round.report.formats).toEqual(PersistedFixture.report.formats)
      expect(round.bind.solana.ports.faucet).toBe(
        BindConfigProvider.DefaultSolanaFaucet
      )
    })

    it("round-trips solanaEpochWarp (default OFF, and ON when a flow opts in)", () => {
      expect(ClusterConfigProvider.DefaultSolanaEpochWarp).toBe(false)
      const off = ClusterConfigProvider.deserialize(
        ClusterConfigProvider.serialize(fixtureConfig())
      )
      expect(off.solanaEpochWarp).toBe(false)
      const on = ClusterConfigProvider.deserialize(
        JSON.stringify({ ...PersistedFixture, solanaEpochWarp: true })
      )
      expect(on.solanaEpochWarp).toBe(true)
    })
  })

  describe("save / loadSync round-trip", () => {
    let dir: string
    beforeEach(() => {
      dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "clustercfg-"))
    })
    afterEach(() => {
      Fs.rmSync(dir, { recursive: true, force: true })
    })

    it("writes cluster-config.json and reloads it", async () => {
      const file = Path.join(dir, ClusterConfigProvider.ConfigFilename)
      // Build a fixture whose clusterPath is the temp dir so save() lands there.
      const cfg = ClusterConfigProvider.deserialize(
        JSON.stringify({
          ...PersistedFixture,
          clusterPath: dir
        })
      )
      const saved = await ClusterConfigProvider.save(cfg)
      expect(saved).toBe(cfg)
      expect(Fs.existsSync(file)).toBe(true)
      const reloaded = ClusterConfigProvider.loadSync(file)
      expect(reloaded.clusterPath).toBe(dir)
      expect(reloaded.bind.nodeop.ports.batch).toHaveLength(3)
    })
  })

  describe("toSecretId", () => {
    it("renders {cluster}/{account}/{keyType} placeholders", () => {
      expect(
        ClusterConfigProvider.toSecretId(
          "/wire-sysio/{cluster}/keys/{account}/{keyType}",
          { cluster: "testnet", account: "batchop1", keyType: "K1" }
        )
      ).toBe("/wire-sysio/testnet/keys/batchop1/K1")
    })

    it("fails fast on an unknown placeholder", () => {
      expect(() =>
        ClusterConfigProvider.toSecretId("/keys/{bogus}", {
          cluster: "c",
          account: "a",
          keyType: "K1"
        })
      ).toThrow(/unknown placeholder \{bogus\}/)
    })
  })

  describe("signatureProvider / externalOutposts persistence", () => {
    it("defaults signatureProvider to KEY when a persisted config omits it", () => {
      const parsed = JSON.parse(
        ClusterConfigProvider.serialize(fixtureConfig())
      )
      delete parsed.signatureProvider
      delete parsed.externalOutposts
      const cfg = ClusterConfigProvider.deserialize(JSON.stringify(parsed))
      expect(cfg.signatureProvider).toEqual({
        type: SignatureProviderType.KEY,
        ssm: null
      })
      expect(cfg.externalOutposts).toBeNull()
    })

    it("round-trips an SSM signatureProvider + externalOutposts config", () => {
      const cfg = fixtureConfig({
        signatureProvider: {
          type: SignatureProviderType.SSM,
          ssm: {
            awsRegion: "us-east-1",
            awsSecretIdPattern: "/wire/{cluster}/{account}/{keyType}"
          }
        },
        externalOutposts: {
          ethereum: {
            addressFile: "/x/outpost-addrs.json",
            abiFiles: ["/x/eth-abis/OPP.json"],
            chainId: 1
          },
          solana: { idlFile: "/x/idl.json" }
        }
      })
      const round = ClusterConfigProvider.deserialize(
        ClusterConfigProvider.serialize(cfg)
      )
      expect(round.signatureProvider.type).toBe(SignatureProviderType.SSM)
      expect(round.externalOutposts?.ethereum.chainId).toBe(1)
    })
  })

  describe("signatureProviderSource", () => {
    it("KEY → the inline default source for every key (byte-identical)", () => {
      const source = ClusterConfigProvider.signatureProviderSource(
        fixtureConfig()
      )
      expect(source("node_00", KeyType.K1)).toEqual({
        type: SignatureProviderType.KEY
      })
      expect(source("batchop.a", KeyType.EM)).toEqual({
        type: SignatureProviderType.KEY
      })
    })

    it("SSM → region + per-key rendered secret id from the pattern", () => {
      const config = fixtureConfig({
          clusterPath: "/tmp/wire-cluster-x",
          signatureProvider: {
            type: SignatureProviderType.SSM,
            ssm: {
              awsRegion: "us-east-1",
              awsSecretIdPattern: "/wire/{cluster}/{account}/{keyType}"
            }
          }
        }),
        source = ClusterConfigProvider.signatureProviderSource(config)
      expect(source("batchop.a", KeyType.K1)).toEqual({
        type: SignatureProviderType.SSM,
        awsRegion: "us-east-1",
        awsSecretId: "/wire/wire-cluster-x/batchop.a/K1"
      })
      expect(source("node_00", KeyType.BLS)).toEqual({
        type: SignatureProviderType.SSM,
        awsRegion: "us-east-1",
        awsSecretId: "/wire/wire-cluster-x/node_00/BLS"
      })
    })

    it("KIOD → the kiod wallet URL for every key", () => {
      const config = fixtureConfig({
          signatureProvider: { type: SignatureProviderType.KIOD, ssm: null }
        }),
        source = ClusterConfigProvider.signatureProviderSource(config),
        result = source("uwrit.b", KeyType.ED)
      expect(result.type).toBe(SignatureProviderType.KIOD)
      expect(result.kiodUrl).toMatch(/^http:\/\//)
    })
  })

  describe("resolve --bind-config classify/merge", () => {
    const previousRegistry = process.env.WIRE_BIND_REGISTRY_PATH
    let dir: string, buildPath: string

    beforeEach(() => {
      dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "bind-config-"))
      process.env.WIRE_BIND_REGISTRY_PATH = Path.join(dir, "registry")
      // resolveExecutables asserts nodeop/kiod/clio exist under buildPath/bin.
      buildPath = Path.join(dir, "build")
      Fs.mkdirSync(Path.join(buildPath, "bin"), { recursive: true })
      ;["nodeop", "kiod", "clio"].forEach(bin =>
        Fs.writeFileSync(Path.join(buildPath, "bin", bin), "")
      )
    })
    afterEach(() => {
      if (previousRegistry == null) delete process.env.WIRE_BIND_REGISTRY_PATH
      else process.env.WIRE_BIND_REGISTRY_PATH = previousRegistry
      Fs.rmSync(dir, { recursive: true, force: true })
    })

    /** Write a JSON bind (config or partial override) to the temp dir. */
    function writeBindConfig(bind: unknown): string {
      const file = Path.join(dir, "bind.json")
      Fs.writeFileSync(file, JSON.stringify(bind))
      return file
    }
    /** Base create options (fake host paths; binaries resolve off PATH). */
    function baseOptions(bindConfig: string, extra: object = {}) {
      return {
        clusterPath: Path.join(dir, "cluster"),
        buildPath,
        ethereumPath: "/fake/eth",
        solanaPath: "/fake/sol",
        bindConfig,
        ...extra
      }
    }

    it("uses a COMPLETE bind config verbatim (ports not re-picked)", async () => {
      const bind = JSON.parse(JSON.stringify(PersistedFixture.bind)),
        config = await ClusterConfigProvider.resolve(
          baseOptions(writeBindConfig(bind))
        )
      expect(config.bind.kiod.port).toBe(bind.kiod.port)
      expect(config.bind.nodeop.ports.bios.http).toBe(
        bind.nodeop.ports.bios.http
      )
    })

    it("rejects a COMPLETE bind config whose node cardinality mismatches the topology", async () => {
      const bind = JSON.parse(JSON.stringify(PersistedFixture.bind))
      bind.nodeop.ports.producers.push({ http: 19_999, p2p: 19_998 })
      await expect(
        ClusterConfigProvider.resolve(baseOptions(writeBindConfig(bind)))
      ).rejects.toThrow(
        /nodeop\.ports\.producers has 2 entries but the cluster topology expects 1/
      )
    })

    it("rejects a remote anvil bind without --external-outpost-config", async () => {
      const bind = JSON.parse(JSON.stringify(PersistedFixture.bind))
      bind.anvil.address = "10.0.0.5"
      await expect(
        ClusterConfigProvider.resolve(baseOptions(writeBindConfig(bind)))
      ).rejects.toThrow(/requires[\s\S]*external-outpost-config/)
    })

    it("merges a PARTIAL bind config over resolver defaults (file pins the kiod port)", async () => {
      const kiodPort = await freeTcpPort(),
        config = await ClusterConfigProvider.resolve(
          baseOptions(writeBindConfig({ kiod: { port: kiodPort } }))
        )
      expect(config.bind.kiod.port).toBe(kiodPort)
      expect(typeof config.bind.nodeop.ports.bios.http).toBe("number")
    })
  })
})
