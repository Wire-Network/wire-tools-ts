import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import {
  AWSAccountName,
  ClusterDeploymentKind,
  DefaultChainStateDbSizeMb,
  SignatureProviderType
} from "@wireio/cluster-tool-shared"
import { KeyType } from "@wireio/sdk-core"

import { KeyGenerator } from "@wireio/cluster-tool/clients/wire"
import {
  BindConfigProvider,
  ClusterConfigProvider,
  NodeConfig,
  NodeRole
} from "@wireio/cluster-tool/config"
import { fixtureConfig, PersistedFixture } from "./clusterConfigFixture.js"
import {
  fixtureResolveEnvironment,
  type ResolveEnvironment
} from "./resolveEnvironmentFixture.js"

/**
 * PREFERRED kiod pin for the partial-bind-config merge test — one ABOVE the
 * kiod default, so the assertion distinguishes "the file's pin was honored"
 * from "the resolver fell back to its own default".
 *
 * This is only the preference handed to {@link BindConfigProvider.findAvailable};
 * the port actually used comes from that registry-aware picker, never from a
 * bare literal and never from a hand-rolled socket grab. Preferring a value
 * BELOW the OS ephemeral range (`/proc/sys/net/ipv4/ip_local_port_range`,
 * 32768+) additionally keeps `resolve`'s own UNPINNED draws — which the kernel
 * can only satisfy from the ephemeral range — from being handed this port
 * partway through the same resolve.
 */
const PartialMergeKiodPin = BindConfigProvider.DefaultKiod + 1

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
    it("renders the canonical 4-segment {cluster}/{account}/{keyType} pattern", () => {
      expect(
        ClusterConfigProvider.toSecretId("/wire/{cluster}/{account}/{keyType}", {
          cluster: AWSAccountName.test,
          account: "batchop.a",
          keyType: "K1"
        })
      ).toBe("/wire/test/batchop.a/K1")
    })

    it("renders the OPTIONAL {version} token when the pattern authors it", () => {
      expect(
        ClusterConfigProvider.toSecretId(
          "/wire/{cluster}/{account}/{keyType}/{version}",
          {
            cluster: AWSAccountName.prod,
            account: "node_00",
            keyType: "BLS",
            version: "v2"
          }
        )
      ).toBe("/wire/prod/node_00/BLS/v2")
    })

    it("fails fast on a {version} the pattern authors but no caller filled", () => {
      expect(() =>
        ClusterConfigProvider.toSecretId("/wire/{cluster}/{version}", {
          cluster: AWSAccountName.dev,
          account: "a",
          keyType: "K1"
        })
      ).toThrow(/unknown or unfilled placeholder \{version\}/)
    })

    it("fails fast on an unknown placeholder", () => {
      expect(() =>
        ClusterConfigProvider.toSecretId("/keys/{bogus}", {
          cluster: AWSAccountName.dev,
          account: "a",
          keyType: "K1"
        })
      ).toThrow(/unknown or unfilled placeholder \{bogus\}/)
    })
  })

  describe("signatureProvider / externalOutposts persistence", () => {
    it("defaults signatureProvider to KEY when a persisted config omits it", () => {
      const parsed = JSON.parse(
        ClusterConfigProvider.serialize(fixtureConfig())
      )
      delete parsed.signatureProvider
      delete parsed.externalOutposts
      delete parsed.awsClusterNodeConfig
      const cfg = ClusterConfigProvider.deserialize(JSON.stringify(parsed))
      expect(cfg.signatureProvider).toEqual({
        type: SignatureProviderType.KEY,
        ssm: null
      })
      expect(cfg.externalOutposts).toBeNull()
      expect(cfg.awsClusterNodeConfig).toBeNull()
    })

    it("round-trips an SSM signatureProvider + awsClusterNodeConfig + externalOutposts config", () => {
      const cfg = fixtureConfig({
        signatureProvider: {
          type: SignatureProviderType.SSM,
          ssm: {
            awsRegions: ["us-east-1", "eu-west-1"],
            awsSecretIdPattern: "/wire/{cluster}/{account}/{keyType}"
          }
        },
        awsClusterNodeConfig: {
          account: AWSAccountName.test,
          regions: ["us-east-1", "eu-west-1"],
          ssm: null
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
      expect(round.signatureProvider.ssm?.awsRegions).toEqual([
        "us-east-1",
        "eu-west-1"
      ])
      expect(round.awsClusterNodeConfig?.account).toBe(AWSAccountName.test)
      expect(round.awsClusterNodeConfig?.regions).toEqual([
        "us-east-1",
        "eu-west-1"
      ])
      expect(round.externalOutposts?.ethereum.chainId).toBe(1)
    })
  })

  describe("signatureProviderSource renders the label it is GIVEN", () => {
    // The renderer must stay injective: it answers about the identity named,
    // never a different one. Which label holds an identity's keys is a FACT
    // recorded on `OperatorAccount.publicationLabel` where the key set is
    // assigned — resolving it in here made the renderer answer about `node_00`
    // when asked about `defproducera`, and added a third copy of the
    // producer-to-node mapping that had to agree with the other two by hand.
    it("does not rewrite a producer account to its node", () => {
      const config = fixtureConfig({
          signatureProvider: {
            type: SignatureProviderType.SSM,
            ssm: {
              awsRegions: ["us-east-1"],
              awsSecretIdPattern: "/wire/{cluster}/{account}/{keyType}"
            }
          },
          awsClusterNodeConfig: {
            account: AWSAccountName.test,
            regions: ["us-east-1"],
            ssm: null
          }
        }),
        source = ClusterConfigProvider.signatureProviderSource(config),
        producer = NodeConfig.plan(config).find(
          node => node.role === NodeRole.producer
        ).producers[0]
      expect(source(producer, KeyType.BLS)).toEqual({
        type: SignatureProviderType.SSM,
        awsSecretId: `/wire/test/${producer}/BLS`
      })
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

    it("SSM → a REGION-LESS per-key secret id keyed by the AWS account, not the cluster dir", () => {
      const config = fixtureConfig({
          clusterPath: "/tmp/wire-cluster-x",
          signatureProvider: {
            type: SignatureProviderType.SSM,
            ssm: {
              awsRegions: ["us-east-1", "eu-west-1"],
              awsSecretIdPattern: "/wire/{cluster}/{account}/{keyType}"
            }
          },
          awsClusterNodeConfig: {
            account: AWSAccountName.test,
            regions: ["us-east-1", "eu-west-1"],
            ssm: null
          }
        }),
        source = ClusterConfigProvider.signatureProviderSource(config)
      // `{cluster}` renders the AWS ACCOUNT (test), never basename(clusterPath).
      expect(source("batchop.a", KeyType.K1)).toEqual({
        type: SignatureProviderType.SSM,
        awsSecretId: "/wire/test/batchop.a/K1"
      })
      expect(source("node_00", KeyType.BLS)).toEqual({
        type: SignatureProviderType.SSM,
        awsSecretId: "/wire/test/node_00/BLS"
      })
    })

    it("SSM → fills the OPTIONAL {version} token from the ssm settings", () => {
      const config = fixtureConfig({
          signatureProvider: {
            type: SignatureProviderType.SSM,
            ssm: {
              awsRegions: ["us-east-1"],
              awsSecretIdPattern: "/wire/{cluster}/{account}/{keyType}/{version}",
              version: "v7"
            }
          },
          awsClusterNodeConfig: {
            account: AWSAccountName.prod,
            regions: ["us-east-1"],
            ssm: null
          }
        }),
        source = ClusterConfigProvider.signatureProviderSource(config)
      expect(source("batchop.a", KeyType.K1).awsSecretId).toBe(
        "/wire/prod/batchop.a/K1/v7"
      )
    })

    it("SSM → fails fast when awsClusterNodeConfig is absent (the {cluster} source)", () => {
      const config = fixtureConfig({
          signatureProvider: {
            type: SignatureProviderType.SSM,
            ssm: {
              awsRegions: ["us-east-1"],
              awsSecretIdPattern: "/wire/{cluster}/{account}/{keyType}"
            }
          }
        }),
        source = ClusterConfigProvider.signatureProviderSource(config)
      expect(() => source("batchop.a", KeyType.K1)).toThrow(
        /requires awsClusterNodeConfig/
      )
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

  describe("resolve batch-operator roster lattice", () => {
    let environment: ResolveEnvironment

    beforeEach(() => {
      environment = fixtureResolveEnvironment("batch-roster-")
    })
    afterEach(() => {
      environment.cleanup()
    })

    /** Base create options (fake host paths; binaries fixture-resolved). */
    function rosterOptions(batchOperatorCount?: number) {
      return {
        clusterPath: Path.join(environment.rootPath, "cluster"),
        buildPath: environment.buildPath,
        ethereumPath: "/fake/eth",
        solanaPath: "/fake/sol",
        ...(batchOperatorCount == null ? {} : { batchOperatorCount })
      }
    }

    // NO accept case drives a full resolve here: a 21-operator topology claims
    // ~50 ports under the host-global bind lock, which starves every other
    // suite's resolve. The default roster's accept path is exercised by every
    // other `resolve` test in this file, and the admissible lattice is covered
    // lock-free in ClusterBuildDefaultsEpochShape.

    // 4/20 are even; 5/7 are odd but not 3-divisible; 6 is 3-divisible but even
    // (an even quotient = an even group size, which breaks the strict-majority
    // path-2 threshold). Every one used to bootstrap ~15 min and then revert in
    // `schbatchgps` with "not enough available batch operators".
    it.each([1, 4, 5, 7, 20])(
      "rejects a roster of %i off the odd/3-divisible lattice",
      async batchOperatorCount => {
        await expect(
          ClusterConfigProvider.resolve(rosterOptions(batchOperatorCount))
        ).rejects.toThrow(/must be ODD and divisible by 3/)
      }
    )

    // The lattice constants themselves are pinned in BatchOperatorSchedule.test.ts.

    // The explicit-shape acceptance case (`6` with a 1 x 3 shape) is covered
    // lock-free in BatchOperatorSchedule.test.ts — driving it through `resolve`
    // claims a cluster's worth of ports under the host-global bind lock.
  })

  describe("resolve signature-provider + AWS placement", () => {
    let environment: ResolveEnvironment

    beforeEach(() => {
      environment = fixtureResolveEnvironment("aws-placement-")
    })
    afterEach(() => {
      environment.cleanup()
    })

    /** Base create options (fake host paths; binaries fixture-resolved). */
    function baseOptions() {
      return {
        clusterPath: Path.join(environment.rootPath, "cluster"),
        buildPath: environment.buildPath,
        ethereumPath: "/fake/eth",
        solanaPath: "/fake/sol"
      }
    }

    /** The SSM ssm-settings leaf (no `awsRegions` — they are derived). */
    function ssmOptions() {
      return {
        type: SignatureProviderType.SSM,
        ssm: { awsSecretIdPattern: "/wire/{cluster}/{account}/{keyType}" }
      }
    }

    it("derives ssm.awsRegions from awsClusterNodeConfig.regions and PERSISTS the placement", async () => {
      const config = await ClusterConfigProvider.resolve({
        ...baseOptions(),
        signatureProvider: ssmOptions(),
        awsClusterNodeConfig: {
          account: AWSAccountName.dev,
          regions: ["us-east-1", "eu-west-1"],
          ssm: null
        }
      })
      expect(config.signatureProvider.ssm?.awsRegions).toEqual([
        "us-east-1",
        "eu-west-1"
      ])
      // The resolved literal must CARRY the placement — an omitted key would
      // silently persist the schema default `null`.
      expect(config.awsClusterNodeConfig).toEqual({
        account: AWSAccountName.dev,
        regions: ["us-east-1", "eu-west-1"],
        ssm: null
      })
    })

    it("rejects an SSM provider with no awsClusterNodeConfig", async () => {
      await expect(
        ClusterConfigProvider.resolve({
          ...baseOptions(),
          signatureProvider: ssmOptions()
        })
      ).rejects.toThrow(
        /awsClusterNodeConfig is required when signatureProvider.type is SSM/
      )
    })

    it("rejects authoring BOTH region sources, naming each one", async () => {
      await expect(
        ClusterConfigProvider.resolve({
          ...baseOptions(),
          signatureProvider: {
            type: SignatureProviderType.SSM,
            ssm: {
              awsRegions: ["us-east-1"],
              awsSecretIdPattern: "/wire/{cluster}/{account}/{keyType}"
            }
          },
          awsClusterNodeConfig: {
            account: AWSAccountName.dev,
            regions: ["us-east-1"],
            ssm: null
          }
        })
      ).rejects.toThrow(
        /signatureProvider\.ssm\.awsRegions and awsClusterNodeConfig\.regions both author/
      )
    })

    it("rejects an awsClusterNodeConfig with no regions", async () => {
      await expect(
        ClusterConfigProvider.resolve({
          ...baseOptions(),
          awsClusterNodeConfig: {
            account: AWSAccountName.dev,
            regions: [],
            ssm: null
          }
        })
      ).rejects.toThrow(/must name at least one AWS region/)
    })

    it("accepts an awsClusterNodeConfig under the default KEY provider (unused there)", async () => {
      const config = await ClusterConfigProvider.resolve({
        ...baseOptions(),
        awsClusterNodeConfig: {
          account: AWSAccountName.prod,
          regions: ["us-west-2"],
          ssm: null
        }
      })
      expect(config.signatureProvider).toEqual({
        type: SignatureProviderType.KEY,
        ssm: null
      })
      expect(config.awsClusterNodeConfig?.account).toBe(AWSAccountName.prod)
    })
  })

  describe("resolve deploymentKind + chainStateDbSizeMb", () => {
    let environment: ResolveEnvironment

    beforeEach(() => {
      environment = fixtureResolveEnvironment("deployment-kind-")
    })
    afterEach(() => {
      environment.cleanup()
    })

    /** Base create options (fake host paths; binaries fixture-resolved). */
    function baseOptions() {
      return {
        clusterPath: Path.join(environment.rootPath, "cluster"),
        buildPath: environment.buildPath,
        ethereumPath: "/fake/eth",
        solanaPath: "/fake/sol"
      }
    }

    it("stamps LOCAL and defaults the chain-state DB size to nodeop's own 1024 MiB", async () => {
      // `resolve` IS the create path — only create-external-config's Rebind
      // stamps `external`, and the default must equal nodeop's stock value so
      // the always-emitted flag changes nothing until it is overridden.
      const config = await ClusterConfigProvider.resolve(baseOptions())
      expect(config.enableMockYieldEmitter).toBe(false)
      expect(config.deploymentKind).toBe(ClusterDeploymentKind.local)
      expect(config.chainStateDbSizeMb).toBe(DefaultChainStateDbSizeMb)
      expect(DefaultChainStateDbSizeMb).toBe(1_024)
    })

    it("lets an explicit chainStateDbSizeMb override win", async () => {
      const config = await ClusterConfigProvider.resolve({
        ...baseOptions(),
        chainStateDbSizeMb: 2_048
      })
      expect(config.chainStateDbSizeMb).toBe(2_048)
      expect(config.deploymentKind).toBe(ClusterDeploymentKind.local)
    })
  })

  describe("resolve --bind-config classify/merge", () => {
    let environment: ResolveEnvironment

    beforeEach(() => {
      environment = fixtureResolveEnvironment("bind-config-")
    })
    afterEach(() => {
      environment.cleanup()
    })

    /** Write a JSON bind (config or partial override) to the temp dir. */
    function writeBindConfig(bind: unknown): string {
      const file = Path.join(environment.rootPath, "bind.json")
      Fs.writeFileSync(file, JSON.stringify(bind))
      return file
    }
    /** Base create options (fake host paths; binaries fixture-resolved). */
    function baseOptions(bindConfig: string, extra: object = {}) {
      return {
        clusterPath: Path.join(environment.rootPath, "cluster"),
        buildPath: environment.buildPath,
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
      const kiodPort = await BindConfigProvider.findAvailable(
        PartialMergeKiodPin
      )
      // findAvailable LOCKS the port in get-port's in-process cache. Release
      // the locks so resolve's PINNED draw can re-acquire the very port the
      // registry just vetted — without this the pin fails deterministically.
      await BindConfigProvider.clearPortLocks()
      const config = await ClusterConfigProvider.resolve(
        baseOptions(writeBindConfig({ kiod: { port: kiodPort } }))
      )
      expect(config.bind.kiod.port).toBe(kiodPort)
      expect(typeof config.bind.nodeop.ports.bios.http).toBe("number")
    })
  })

  describe("assertClusterPathSource", () => {
    it("throws when the options document AND an explicit --cluster-path both author it", () => {
      expect(() =>
        ClusterConfigProvider.assertClusterPathSource(
          { clusterPath: "/tmp/from-file" },
          true
        )
      ).toThrow(/clusterPath is authored twice/)
    })

    it("accepts a document clusterPath with no explicit flag (env is NOT a conflict)", () => {
      expect(() =>
        ClusterConfigProvider.assertClusterPathSource(
          { clusterPath: "/tmp/from-file" },
          false
        )
      ).not.toThrow()
    })

    it("accepts an explicit flag when the document does not author clusterPath", () => {
      expect(() =>
        ClusterConfigProvider.assertClusterPathSource({ epochDurationSec: 60 }, true)
      ).not.toThrow()
      expect(() =>
        ClusterConfigProvider.assertClusterPathSource(null, true)
      ).not.toThrow()
    })
  })

  describe("external outposts vs underwriters", () => {
    let environment: ResolveEnvironment, externalConfigFile: string

    beforeEach(() => {
      environment = fixtureResolveEnvironment("external-underwriters-")
      externalConfigFile = Path.join(environment.rootPath, "external.json")
      Fs.writeFileSync(
        externalConfigFile,
        JSON.stringify({
          ethereum: {
            addressFile: "outpost-addrs.json",
            abiFiles: ["eth-abis/OPP.json"],
            chainId: 11_155_111
          },
          solana: { idlFile: "solana-idls/liqsol_core.json" }
        })
      )
    })

    afterEach(() => {
      environment.cleanup()
    })

    /** Base options for an EXTERNAL-outpost resolve. */
    function externalOptions(extra: object = {}) {
      return {
        clusterPath: Path.join(environment.rootPath, "cluster"),
        buildPath: environment.buildPath,
        ethereumPath: "/fake/eth",
        solanaPath: "/fake/sol",
        externalOutpostConfig: externalConfigFile,
        ...extra
      }
    }

    it("rejects an EXPLICIT non-zero underwriterCount, naming the requested value", async () => {
      await expect(
        ClusterConfigProvider.resolve(externalOptions({ underwriterCount: 3 }))
      ).rejects.toThrow(/underwriterCount was set to 3/)
    })

    it("rejects an OMITTED underwriterCount — the default is ONE underwriter, not zero", async () => {
      await expect(
        ClusterConfigProvider.resolve(externalOptions())
      ).rejects.toThrow(
        new RegExp(
          `underwriterCount was omitted, which defaults to ${ClusterConfigProvider.DefaultUnderwriterCount}`
        )
      )
    })

    it("accepts an EXPLICIT underwriterCount of 0", async () => {
      const config = await ClusterConfigProvider.resolve(
        externalOptions({ underwriterCount: 0 })
      )
      expect(config.underwriterCount).toBe(0)
      expect(config.externalOutposts).not.toBeNull()
    })

    it("leaves LOCAL mode's underwriters untouched", async () => {
      const config = await ClusterConfigProvider.resolve({
        clusterPath: Path.join(environment.rootPath, "local-cluster"),
        buildPath: environment.buildPath,
        ethereumPath: "/fake/eth",
        solanaPath: "/fake/sol"
      })
      expect(config.underwriterCount).toBe(
        ClusterConfigProvider.DefaultUnderwriterCount
      )
    })
  })

  describe("resolveWithBiosKeys", () => {
    let environment: ResolveEnvironment

    beforeEach(() => {
      environment = fixtureResolveEnvironment("bios-keys-")
    })

    afterEach(() => {
      environment.cleanup()
    })

    /** Base options for a KEY-mode resolve. */
    function keyModeOptions() {
      return {
        clusterPath: Path.join(environment.rootPath, "cluster"),
        buildPath: environment.buildPath,
        ethereumPath: "/fake/eth",
        solanaPath: "/fake/sol"
      }
    }

    it("KEY mode returns the well-known dev bios keys — no generation, no SSM I/O", async () => {
      const resolved =
        await ClusterConfigProvider.resolveWithBiosKeys(keyModeOptions())
      expect(resolved.biosWire).toBe(KeyGenerator.BiosK1Key)
      expect(resolved.biosFinalizer).toBe(KeyGenerator.BiosBLSKey)
      // the bootstrap node owner's authority is the same dev K1 under KEY
      expect(resolved.nodeOwnerWire).toBe(KeyGenerator.BiosK1Key)
    })

    it("KEY mode's genesis authority stays byte-identical to the historical bootstrap", async () => {
      const { config } =
        await ClusterConfigProvider.resolveWithBiosKeys(keyModeOptions())
      expect(config.initialKey).toBe(KeyGenerator.BiosK1Key.publicKey)
      expect(config.initialFinalizerKey).toBe(KeyGenerator.BiosBLSKey.publicKey)
    })

    it("plain resolve already carries the same genesis publics (config-only facade)", async () => {
      const config = await ClusterConfigProvider.resolve(keyModeOptions())
      expect(config.initialKey).toBe(KeyGenerator.BiosK1Key.publicKey)
      expect(config.initialFinalizerKey).toBe(KeyGenerator.BiosBLSKey.publicKey)
    })
  })
})
