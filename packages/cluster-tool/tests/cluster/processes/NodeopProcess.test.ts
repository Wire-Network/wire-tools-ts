import Fs from "node:fs"
import Http from "node:http"
import Os from "node:os"
import Path from "node:path"
import {
  AWSAccountName,
  ClusterDeploymentKind,
  DefaultChainStateDbSizeMb,
  SignatureProviderType,
  type ClusterConfig
} from "@wireio/cluster-tool-shared"
import { OperatorType } from "@wireio/opp-typescript-models"
import { KeyType } from "@wireio/sdk-core"
import { Constants } from "@wireio/cluster-tool"
import {
  createNodeopTuningDefaultOptions,
  DatabaseMapMode,
  NodeopProcess,
  type NodeopTuningOptions,
  ProcessManager
} from "@wireio/cluster-tool/cluster/processes"
import {
  NodeConfig,
  NodeRole,
  BindConfigProvider
} from "@wireio/cluster-tool/config"
import { type OperatorAccount } from "@wireio/cluster-tool/orchestration/outputs"
import { Localhost, toURL } from "@wireio/cluster-tool/utils"
import {
  fixtureConfig,
  PersistedFixture
} from "../../config/clusterConfigFixture.js"

/** The chainbase map-mode flag, exactly as `buildArgs` emits it. */
const DatabaseMapModeFlag = "--database-map-mode"

/** The three SHARED-25 deadline flags, exactly as `buildArgs` emits them. */
const MaxTransactionTimeFlag = "--max-transaction-time",
  AbiSerializerMaxTimeFlag = "--abi-serializer-max-time-ms",
  HttpMaxResponseTimeFlag = "--http-max-response-time-ms"

/** The value following `flag` in an argv (each occurrence). */
function valuesOf(args: string[], flag: string): string[] {
  return args.flatMap((arg, index) => (arg === flag ? [args[index + 1]] : []))
}

/** Producers a role's node hosts — only the block-producing roles carry any. */
const RoleProducers: Record<NodeRole, string[]> = {
  [NodeRole.bios]: [NodeConfig.BiosProducer],
  [NodeRole.producer]: ["sysio"],
  [NodeRole.batch_operator]: [],
  [NodeRole.underwriter]: []
}

describe("NodeopProcess", () => {
  let dir: string
  let manager: ProcessManager
  let cluster: ClusterConfig
  beforeAll(() => {
    dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "nodeop-"))
    Fs.writeFileSync(
      Path.join(dir, "genesis.json"),
      JSON.stringify({ initial_timestamp: "2026-01-01T00:00:00.000" })
    )
    ProcessManager.setClusterPath(dir)
    manager = ProcessManager.get()
    // Fixture ClusterConfig aimed at this test's sandbox — NodeopProcess
    // derives node dirs + `genesisFile` from `clusterPath`/`dataPath`, and
    // the fixture's node counts (1/3/1) match the planning assertions below.
    cluster = fixtureConfig({
      clusterPath: dir,
      dataPath: Path.join(dir, "data"),
      executables: { ...PersistedFixture.executables, nodeop: "/bin/true" },
      bind: {
        ...PersistedFixture.bind,
        nodeop: { ...PersistedFixture.bind.nodeop, address: "0.0.0.0" }
      }
    })
  })
  afterEach(async () => {
    await manager.stopAll()
  })
  afterAll(() => {
    Fs.rmSync(dir, { recursive: true, force: true })
  })

  /** A planned node over the structural cluster config. */
  function node(
    name: string,
    role: NodeRole,
    producers: string[] = [],
    peers: string[] = []
  ): NodeConfig {
    return new NodeConfig(
      cluster,
      role,
      0,
      name,
      { http: 8888, p2p: 9876 },
      producers,
      peers
    )
  }

  /** A producer OperatorAccount carrying the node-shared signing keys. */
  /**
   * @param account - the ON-CHAIN name the node produces under.
   * @param publicationLabel - the label its keys are published under; defaults to the account,
   *   which is what a provisioned producer carries. The bios identity is the exception the live
   *   path also carries (`ClusterBuild.create` seeds it with `NodeConfig.BiosName`): its account
   *   is the genesis producer while its secret-id segment is the NODE name.
   * @returns a producer identity with a K1 + BLS pair.
   */
  function producerOperator(
    account: string,
    publicationLabel = account
  ): OperatorAccount {
    return {
      account,
      label: account,
      publicationLabel,
      type: OperatorType.PRODUCER,
      wire: { type: KeyType.K1, publicKey: "PUB_K1_p", privateKey: "PVT_K1_s" },
      wireFinalizer: {
        type: KeyType.BLS,
        publicKey: "PUB_BLS_p",
        privateKey: "PVT_BLS_s",
        proofOfPossession: "SIG_BLS_x"
      }
    }
  }

  it("requires genesis.json to exist", async () => {
    // `genesisFile` derives from `clusterPath` — a cluster path with no
    // genesis.json written under it is the missing-genesis case.
    const missing = fixtureConfig({
      clusterPath: "/nope",
      dataPath: Path.join(dir, "data"),
      executables: { ...PersistedFixture.executables, nodeop: "/bin/true" },
      bind: {
        ...PersistedFixture.bind,
        nodeop: { ...PersistedFixture.bind.nodeop, address: "0.0.0.0" }
      }
    })
    await expect(
      NodeopProcess.create(manager, {
        node: new NodeConfig(
          missing,
          NodeRole.producer,
          0,
          "missing-genesis",
          { http: 1, p2p: 2 },
          [],
          []
        )
      })
    ).rejects.toThrow(/genesis/)
  })

  it("requires a producer OperatorAccount (wire + wireFinalizer) for a producing node", async () => {
    await expect(
      NodeopProcess.create(manager, {
        node: node("keyless", NodeRole.producer, ["sysio"])
      })
    ).rejects.toThrow(/requires one producer OperatorAccount per hosted producer/)
  })

  it("builds a producer node's argv from the composed node + operator", async () => {
    const nodeop = await NodeopProcess.create(manager, {
      node: node("producer", NodeRole.producer, ["sysio"], ["127.0.0.1:9877"]),
      operators: [producerOperator("sysio")]
    })
    expect(nodeop.exe).toBe("/bin/true")
    expect(nodeop.args).toEqual(
      expect.arrayContaining([
        "--plugin",
        "sysio::producer_plugin",
        "--producer-name",
        "sysio",
        "--p2p-peer-address",
        "127.0.0.1:9877",
        "--genesis-json",
        "--genesis-timestamp",
        "2026-01-01T00:00:00.000"
      ])
    )
    // endpoints derive from the cluster bind address + the node's ports
    expect(nodeop.args).toEqual(
      expect.arrayContaining(["--p2p-listen-endpoint", "0.0.0.0:9876"])
    )
    expect(
      nodeop.args.filter(arg => arg === "--signature-provider")
    ).toHaveLength(2)
    expect(nodeop.args.some(arg => arg.includes("wire-PUB_K1_p"))).toBe(true)
    expect(nodeop.args.some(arg => arg.includes("wire-bls-PUB_BLS_p"))).toBe(
      true
    )
    expect(nodeop.httpUrl).toContain(Localhost)
  })

  it("omits the producer block for a non-producing node + appends extraArgs", async () => {
    const nodeop = await NodeopProcess.create(manager, {
      node: node("operator-daemon", NodeRole.batch_operator),
      operators: [producerOperator("batchopaaaa")],
      extraArgs: ["--batch-operator-account", "wireno.batchopaaaa"]
    })
    expect(nodeop.args).not.toContain("sysio::producer_plugin")
    expect(nodeop.args).not.toContain("--producer-name")
    expect(nodeop.args).toEqual(
      expect.arrayContaining([
        "--plugin",
        "sysio::net_plugin",
        "--batch-operator-account",
        "wireno.batchopaaaa"
      ])
    )
  })

  it("advertises the per-node advertiseAddress as the p2p-server-address", async () => {
    const meshNode = new NodeConfig(
      cluster,
      NodeRole.batch_operator,
      0,
      "meshed",
      { http: 8888, p2p: 9876, advertiseAddress: "10.1.2.3" },
      [],
      []
    )
    const nodeop = await NodeopProcess.create(manager, { node: meshNode })
    expect(nodeop.args).toEqual(
      expect.arrayContaining(["--p2p-server-address", "10.1.2.3:9876"])
    )
    // the LISTEN endpoint stays on the fleet-wide bind address
    expect(nodeop.args).toEqual(
      expect.arrayContaining(["--p2p-listen-endpoint", "0.0.0.0:9876"])
    )
  })

  describe("signature-provider scheme plugins", () => {
    const SSMPlugin =
      NodeopProcess.SignatureProviderSchemePlugins[SignatureProviderType.SSM]

    /** The fixture cluster re-aimed at an SSM signature provider. */
    function ssmCluster(): ClusterConfig {
      return fixtureConfig({
        clusterPath: dir,
        dataPath: Path.join(dir, "data"),
        executables: { ...PersistedFixture.executables, nodeop: "/bin/true" },
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
    }

    it("requiredSignatureProviderPlugins maps a REGION-LESS SSM spec to the ssm plugin", () => {
      expect(
        NodeopProcess.requiredSignatureProviderPlugins([
          NodeopProcess.SignatureProviderFlag,
          "name,wire,wire,PUB_K1_p,SSM:/wire/c/a/K1"
        ])
      ).toEqual([SSMPlugin])
    })

    it("requiredSignatureProviderPlugins still maps the explicit-region SSM form", () => {
      // The depot plugin accepts `<region>:<name>` too — scheme detection reads
      // the leading token either way.
      expect(
        NodeopProcess.requiredSignatureProviderPlugins([
          NodeopProcess.SignatureProviderFlag,
          "name,wire,wire,PUB_K1_p,SSM:us-east-1:/wire/c/a/K1"
        ])
      ).toEqual([SSMPlugin])
    })

    it("requiredSignatureProviderPlugins is empty for KEY / KIOD specs and non-spec args", () => {
      expect(
        NodeopProcess.requiredSignatureProviderPlugins([
          NodeopProcess.SignatureProviderFlag,
          "name,wire,wire,PUB_K1_p,KEY:PVT_K1_s",
          NodeopProcess.SignatureProviderFlag,
          "name2,wire,wire_bls,PUB_BLS_p,KIOD:http://127.0.0.1:8900",
          NodeopProcess.PluginFlag,
          "sysio::net_plugin"
        ])
      ).toEqual([])
    })

    it("requiredSignatureProviderPlugins dedupes and skips already-enabled plugins", () => {
      const twoSSMSpecs = [
        NodeopProcess.SignatureProviderFlag,
        "a,wire,wire,P1,SSM:/s1",
        NodeopProcess.SignatureProviderFlag,
        "b,wire,wire_bls,P2,SSM:/s2"
      ]
      expect(
        NodeopProcess.requiredSignatureProviderPlugins(twoSSMSpecs)
      ).toEqual([SSMPlugin])
      expect(
        NodeopProcess.requiredSignatureProviderPlugins([
          ...twoSSMSpecs,
          NodeopProcess.PluginFlag,
          SSMPlugin
        ])
      ).toEqual([])
    })

    it("an SSM cluster's producing node enables the ssm plugin (the 3110006 fix)", async () => {
      const producing = new NodeConfig(
        ssmCluster(),
        NodeRole.producer,
        0,
        "ssm-producer",
        { http: 8888, p2p: 9876 },
        ["sysio"],
        []
      )
      const nodeop = await NodeopProcess.create(manager, {
        node: producing,
        operators: [producerOperator("sysio")]
      })
      expect(nodeop.args).toEqual(
        expect.arrayContaining([NodeopProcess.PluginFlag, SSMPlugin])
      )
      // REGION-LESS, `{cluster}` = the AWS account (`dev`), not the cluster dir.
      expect(nodeop.args.some(arg => arg.includes("SSM:/wire/dev/"))).toBe(true)
      expect(nodeop.args.some(arg => arg.includes("SSM::"))).toBe(false)
    })

    /** The bios node planned over `cluster`. */
    function biosNode(cluster: ClusterConfig): NodeConfig {
      return new NodeConfig(
        cluster,
        NodeRole.bios,
        NodeConfig.BiosIndex,
        NodeConfig.BiosName,
        { http: 8788, p2p: 8776 },
        [NodeConfig.BiosProducer],
        []
      )
    }

    it("an SSM cluster's bios node fetches its GENERATED genesis keys from SSM", async () => {
      // Under SSM the bios key is generated (or adopted) at config resolution
      // like any other node key — it is NOT exempt from the provider source.
      const nodeop = await NodeopProcess.create(manager, {
        node: biosNode(ssmCluster()),
        operators: [
          producerOperator(NodeConfig.BiosProducer, NodeConfig.BiosName)
        ]
      })
      expect(nodeop.args).toEqual(
        expect.arrayContaining([NodeopProcess.PluginFlag, SSMPlugin])
      )
      // `{account}` is the NODE NAME, and the spec stays REGION-LESS.
      expect(
        nodeop.args.some(arg =>
          arg.includes(`SSM:/wire/dev/${NodeConfig.BiosName}/`)
        )
      ).toBe(true)
      expect(nodeop.args.some(arg => arg.includes("SSM::"))).toBe(false)
    })

    it("a KIOD cluster's bios node keeps the INLINE dev KEY spec (never a kiod lookup)", async () => {
      const kiodCluster = fixtureConfig({
        clusterPath: dir,
        dataPath: Path.join(dir, "data"),
        executables: { ...PersistedFixture.executables, nodeop: "/bin/true" },
        signatureProvider: { type: SignatureProviderType.KIOD, ssm: null }
      })
      const nodeop = await NodeopProcess.create(manager, {
        node: biosNode(kiodCluster),
        operators: [
          producerOperator(NodeConfig.BiosProducer, NodeConfig.BiosName)
        ]
      })
      expect(nodeop.args.some(arg => arg.includes("KEY:PVT_K1_"))).toBe(true)
      expect(nodeop.args.some(arg => arg.includes("KIOD:"))).toBe(false)
    })

    it("a KEY cluster never enables the ssm plugin", async () => {
      const nodeop = await NodeopProcess.create(manager, {
        node: node("key-producer", NodeRole.producer, ["sysio"]),
        operators: [producerOperator("sysio")]
      })
      expect(nodeop.args).not.toContain(SSMPlugin)
    })

    it("detects an SSM spec arriving via extraArgs (operator daemons)", async () => {
      const nodeop = await NodeopProcess.create(manager, {
        node: node("ssm-daemon", NodeRole.batch_operator),
        extraArgs: [
          NodeopProcess.SignatureProviderFlag,
          "op,ethereum,ethereum,0xPUB,SSM:/wire/c/op/EM"
        ]
      })
      expect(nodeop.args).toEqual(
        expect.arrayContaining([NodeopProcess.PluginFlag, SSMPlugin])
      )
    })
  })

  it("applies tuning overrides over the defaults", async () => {
    const nodeop = await NodeopProcess.create(manager, {
        node: node("tuned", NodeRole.batch_operator),
        tuning: { maxClients: 99, databaseMapMode: DatabaseMapMode.mapped }
      }),
      mapModeIndex = nodeop.args.indexOf(DatabaseMapModeFlag)
    expect(nodeop.args).toEqual(expect.arrayContaining(["--max-clients", "99"]))
    expect(nodeop.args).toEqual(
      expect.arrayContaining([
        "--vote-threads",
        String(NodeopProcess.DefaultVoteThreads)
      ])
    )
    // An explicit map mode wins over the SHARED-28 default — and the default
    // spelling is then nowhere in the argv.
    expect(nodeop.args[mapModeIndex + 1]).toBe(DatabaseMapMode.mapped)
    expect(nodeop.args).not.toContain(NodeopProcess.DefaultDatabaseMapMode)
  })

  describe("deadline phase/role matrix (SHARED-25 AC#2 + AC#3)", () => {
    /** The three deadline flags' values in one launch form's argv. */
    function deadlines(args: string[]) {
      return {
        maxTransactionTime: valuesOf(args, MaxTransactionTimeFlag),
        abiSerializerMaxTimeMs: valuesOf(args, AbiSerializerMaxTimeFlag),
        httpMaxResponseTimeMs: valuesOf(args, HttpMaxResponseTimeFlag)
      }
    }

    /** A launched node's argv for `role` at `postBootstrap`. */
    async function argsFor(
      role: NodeRole,
      postBootstrap?: boolean,
      tuning?: NodeopTuningOptions
    ): Promise<string[]> {
      const nodeop = await NodeopProcess.create(manager, {
        node: node(
          `deadline-${role}-${String(postBootstrap)}`,
          role,
          RoleProducers[role]
        ),
        operators: [producerOperator("sysio")],
        postBootstrap,
        tuning
      })
      return nodeop.args
    }

    it("pins the five phase/role constants", () => {
      expect(NodeopProcess.BootstrapMaxTransactionTime).toBe(-1)
      expect(NodeopProcess.BootstrapAbiSerializerMaxTimeMs).toBe(990_000)
      expect(NodeopProcess.BootstrapHttpMaxResponseTimeMs).toBe(990_000)
      expect(NodeopProcess.OperatorAbiSerializerMaxTimeMs).toBe(990_000)
      expect(NodeopProcess.OperatorHttpMaxResponseTimeMs).toBe(990_000)
    })

    it("carries NO phase-blind Default* deadline constants", () => {
      // The old trio was a single permissive value for every launch form. A
      // survivor would be a second, phase-blind source of these deadlines.
      expect("DefaultMaxTransactionTime" in NodeopProcess).toBe(false)
      expect("DefaultAbiSerializerMaxTimeMs" in NodeopProcess).toBe(false)
      expect("DefaultHttpMaxResponseTimeMs" in NodeopProcess).toBe(false)
      // The POSITIVE control the three negatives need: `in` on a namespace
      // object answers false for ANY typo, so without these the assertions
      // above would pass against a renamed namespace or an empty object.
      expect("BootstrapMaxTransactionTime" in NodeopProcess).toBe(true)
      expect("BootstrapAbiSerializerMaxTimeMs" in NodeopProcess).toBe(true)
      expect("BootstrapHttpMaxResponseTimeMs" in NodeopProcess).toBe(true)
      expect("OperatorAbiSerializerMaxTimeMs" in NodeopProcess).toBe(true)
      expect("OperatorHttpMaxResponseTimeMs" in NodeopProcess).toBe(true)
    })

    // Driven off `NodeRole` so a new role is covered by construction rather
    // than by remembering to add a case.
    it.each(Object.values(NodeRole))(
      "keeps the permissive bootstrap values on a %s node (postBootstrap UNSET)",
      async role => {
        // Author directive: the rules apply only AFTER a complete bootstrap —
        // until then none of them, on any role.
        expect(deadlines(await argsFor(role))).toEqual({
          maxTransactionTime: [
            String(NodeopProcess.BootstrapMaxTransactionTime)
          ],
          abiSerializerMaxTimeMs: [
            String(NodeopProcess.BootstrapAbiSerializerMaxTimeMs)
          ],
          httpMaxResponseTimeMs: [
            String(NodeopProcess.BootstrapHttpMaxResponseTimeMs)
          ]
        })
      }
    )

    it.each(Object.values(NodeRole))(
      "treats an EXPLICIT postBootstrap:false %s node as the bootstrap form",
      async role => {
        expect(deadlines(await argsFor(role, false))).toEqual({
          maxTransactionTime: [
            String(NodeopProcess.BootstrapMaxTransactionTime)
          ],
          abiSerializerMaxTimeMs: [
            String(NodeopProcess.BootstrapAbiSerializerMaxTimeMs)
          ],
          httpMaxResponseTimeMs: [
            String(NodeopProcess.BootstrapHttpMaxResponseTimeMs)
          ]
        })
      }
    )

    it.each(Object.values(NodeRole))(
      "OMITS --max-transaction-time on a post-bootstrap %s node",
      async role => {
        // AC#2 is role-blind: nodeop's stock 499ms deadline applies to every
        // role once the chain is up.
        expect(await argsFor(role, true)).not.toContain(MaxTransactionTimeFlag)
      }
    )

    it.each([NodeRole.bios, NodeRole.producer])(
      "OMITS BOTH timeout flags on a post-bootstrap %s node",
      async role => {
        // AC#3 tightens the serializer / response deadlines for the
        // public-API-serving roles: no flag, so nodeop's own defaults apply.
        expect(deadlines(await argsFor(role, true))).toEqual({
          maxTransactionTime: [],
          abiSerializerMaxTimeMs: [],
          httpMaxResponseTimeMs: []
        })
      }
    )

    it.each([NodeRole.batch_operator, NodeRole.underwriter])(
      "keeps both timeout flags on a post-bootstrap %s node (AC#3's non-public exception)",
      async role => {
        // An operator node's HTTP surface serves its own co-located OPP daemon
        // only — its envelope + table reads are legitimately slow.
        expect(deadlines(await argsFor(role, true))).toEqual({
          maxTransactionTime: [],
          abiSerializerMaxTimeMs: [
            String(NodeopProcess.OperatorAbiSerializerMaxTimeMs)
          ],
          httpMaxResponseTimeMs: [
            String(NodeopProcess.OperatorHttpMaxResponseTimeMs)
          ]
        })
      }
    )

    it("lets an explicit caller override win on the BOOTSTRAP form", async () => {
      const args = await argsFor(NodeRole.producer, false, {
        maxTransactionTime: 250,
        abiSerializerMaxTimeMs: 1_500,
        httpMaxResponseTimeMs: 2_500
      })
      expect(deadlines(args)).toEqual({
        maxTransactionTime: ["250"],
        abiSerializerMaxTimeMs: ["1500"],
        httpMaxResponseTimeMs: ["2500"]
      })
    })

    it("lets an explicit caller override win on the POST-BOOTSTRAP form (even where the default is ABSENT)", async () => {
      // The absent-default arm is the interesting one: `lodash.defaults` only
      // fills keys the DEFAULTS object carries, so a caller value has nothing
      // to lose a merge against — it must survive verbatim.
      const args = await argsFor(NodeRole.producer, true, {
        maxTransactionTime: 250,
        abiSerializerMaxTimeMs: 1_500,
        httpMaxResponseTimeMs: 2_500
      })
      expect(deadlines(args)).toEqual({
        maxTransactionTime: ["250"],
        abiSerializerMaxTimeMs: ["1500"],
        httpMaxResponseTimeMs: ["2500"]
      })
    })

    describe("lodash.defaults merge semantics for the optional deadlines", () => {
      /** `resolveConfig`'s tuning for a `role` node at `postBootstrap`. */
      function tuningFor(
        role: NodeRole,
        postBootstrap: boolean,
        tuning?: NodeopTuningOptions
      ) {
        return NodeopProcess.resolveConfig(
          {
            node: node(
              `merge-${role}-${String(postBootstrap)}`,
              role,
              RoleProducers[role]
            ),
            operators: [producerOperator("sysio")],
            postBootstrap,
            tuning
          },
          {
            genesisTimestamp: "2026-01-01T00:00:00.000",
            supportsTraceNoAbis: false
          }
        ).tuning
      }

      it("leaves an explicitly-undefined caller slot ABSENT when the phase has no default", () => {
        // `defaults` iterates the SOURCE's keys, so a destination key holding
        // `undefined` with no matching default key stays `undefined` — which
        // buildArgs reads as "omit the flag".
        const tuning = tuningFor(NodeRole.producer, true, {
          maxTransactionTime: undefined,
          abiSerializerMaxTimeMs: undefined,
          httpMaxResponseTimeMs: undefined
        })
        expect(tuning.maxTransactionTime).toBeUndefined()
        expect(tuning.abiSerializerMaxTimeMs).toBeUndefined()
        expect(tuning.httpMaxResponseTimeMs).toBeUndefined()
      })

      it("FILLS an explicitly-undefined caller slot from the phase default when one exists", () => {
        // The other half of the same rule: `undefined` is exactly what
        // `defaults` treats as "not supplied", so the bootstrap arm still wins.
        const tuning = tuningFor(NodeRole.producer, false, {
          maxTransactionTime: undefined,
          abiSerializerMaxTimeMs: undefined,
          httpMaxResponseTimeMs: undefined
        })
        expect(tuning.maxTransactionTime).toBe(
          NodeopProcess.BootstrapMaxTransactionTime
        )
        expect(tuning.abiSerializerMaxTimeMs).toBe(
          NodeopProcess.BootstrapAbiSerializerMaxTimeMs
        )
        expect(tuning.httpMaxResponseTimeMs).toBe(
          NodeopProcess.BootstrapHttpMaxResponseTimeMs
        )
      })

      it("keeps every NON-deadline knob required and phase-independent", () => {
        // Only the three deadlines moved into the optional group; a phase must
        // never be able to drop the map mode or the topology-derived caps.
        ;[false, true].forEach(postBootstrap => {
          const tuning = tuningFor(NodeRole.batch_operator, postBootstrap)
          expect(tuning.databaseMapMode).toBe(
            NodeopProcess.DefaultDatabaseMapMode
          )
          expect(tuning.voteThreads).toBe(NodeopProcess.DefaultVoteThreads)
          expect(tuning.blocksPath).toBe(NodeopProcess.DefaultBlocksPath)
          expect(tuning.connectionCleanupPeriodSec).toBe(
            NodeopProcess.DefaultConnectionCleanupPeriodSec
          )
          expect(tuning.contractsConsole).toBe(true)
          expect(tuning.maxClients).toBe(NodeConfig.peerCapacity(cluster))
          expect(tuning.p2pMaxNodesPerHost).toBe(
            NodeConfig.peerCapacity(cluster)
          )
        })
      })
    })
  })

  describe("trace_api plugin gating (SHARED-25 AC#4 / the author's D3 carve-out)", () => {
    /** The `--plugin` values of an argv (never a stray matching token). */
    function pluginsOf(args: string[]): string[] {
      return valuesOf(args, NodeopProcess.PluginFlag)
    }

    /**
     * The argv for `role` over a cluster of `deploymentKind`, built through the
     * PURE builder with the `--trace-no-abis` capability forced ON: the real
     * probe shells `<nodeop> --help` (here `/bin/true`, which prints nothing),
     * so a live probe would hide the flag for an unrelated reason.
     */
    function argsFor(
      deploymentKind: ClusterDeploymentKind,
      role: NodeRole
    ): string[] {
      const clusterOfKind = fixtureConfig({
          clusterPath: dir,
          dataPath: Path.join(dir, "data"),
          executables: { ...PersistedFixture.executables, nodeop: "/bin/true" },
          deploymentKind
        }),
        planned = new NodeConfig(
          clusterOfKind,
          role,
          0,
          `trace-${deploymentKind}-${role}`,
          // Replayed from the fixture's ALREADY-RESOLVED bind (the sanctioned
          // carve-out) — nothing binds here, and no port is invented.
          clusterOfKind.bind.nodeop.ports.producers[0],
          RoleProducers[role],
          []
        )
      return NodeopProcess.buildArgs(
        NodeopProcess.resolveConfig(
          {
            node: planned,
            operators: [producerOperator("sysio")],
            postBootstrap: true
          },
          {
            genesisTimestamp: "2026-01-01T00:00:00.000",
            supportsTraceNoAbis: true
          }
        )
      )
    }

    // The D3 regression pin: a LOCAL cluster keeps the plugin on EVERY role,
    // because the harness's WireClient reads traces off producer[0].
    it.each(Object.values(NodeRole))(
      "keeps trace_api + --trace-no-abis on a LOCAL %s node",
      role => {
        const args = argsFor(ClusterDeploymentKind.local, role)
        expect(pluginsOf(args)).toContain(Constants.TRACE_API_PLUGIN)
        expect(args).toContain(NodeopProcess.TraceNoAbisFlag)
      }
    )

    it.each([NodeRole.bios, NodeRole.producer])(
      "drops trace_api AND --trace-no-abis from an EXTERNAL %s node",
      role => {
        // The flag belongs to the plugin: nodeop rejects it outright when
        // trace_api_plugin is not loaded, so the two must move together.
        const args = argsFor(ClusterDeploymentKind.external, role)
        expect(pluginsOf(args)).not.toContain(Constants.TRACE_API_PLUGIN)
        expect(args).not.toContain(NodeopProcess.TraceNoAbisFlag)
      }
    )

    it.each([NodeRole.batch_operator, NodeRole.underwriter])(
      "keeps trace_api + --trace-no-abis on an EXTERNAL %s node (non-public)",
      role => {
        const args = argsFor(ClusterDeploymentKind.external, role)
        expect(pluginsOf(args)).toContain(Constants.TRACE_API_PLUGIN)
        expect(args).toContain(NodeopProcess.TraceNoAbisFlag)
      }
    )

    it.each(Object.values(NodeRole))(
      "keeps producer_api UNCONDITIONAL on a %s node of either kind",
      role => {
        // Only trace_api left the trailing set; producer_api is load-bearing on
        // bios / producers (the resume endpoint) and role-blind by design.
        Object.values(ClusterDeploymentKind).forEach(deploymentKind =>
          expect(pluginsOf(argsFor(deploymentKind, role))).toContain(
            "sysio::producer_api_plugin"
          )
        )
      }
    )
  })

  describe("createNodeopTuningDefaultOptions", () => {
    /** The phase/role-independent half every arm must carry unchanged. */
    function unconditionalDefaults() {
      return {
        blocksPath: NodeopProcess.DefaultBlocksPath,
        voteThreads: NodeopProcess.DefaultVoteThreads,
        p2pMaxNodesPerHost: NodeConfig.peerCapacity(cluster),
        maxClients: NodeConfig.peerCapacity(cluster),
        connectionCleanupPeriodSec:
          NodeopProcess.DefaultConnectionCleanupPeriodSec,
        databaseMapMode: NodeopProcess.DefaultDatabaseMapMode,
        contractsConsole: true
      }
    }

    it.each(Object.values(NodeRole))(
      "returns the permissive bootstrap deadlines for a %s node",
      role => {
        // The bootstrap arm is role-blind: until a complete bootstrap none of
        // the SHARED-25 rules apply, on any role.
        expect(
          createNodeopTuningDefaultOptions(
            node(`tuning-bootstrap-${role}`, role, RoleProducers[role]),
            false
          )
        ).toEqual({
          ...unconditionalDefaults(),
          maxTransactionTime: NodeopProcess.BootstrapMaxTransactionTime,
          abiSerializerMaxTimeMs: NodeopProcess.BootstrapAbiSerializerMaxTimeMs,
          httpMaxResponseTimeMs: NodeopProcess.BootstrapHttpMaxResponseTimeMs
        })
      }
    )

    it.each([NodeRole.batch_operator, NodeRole.underwriter])(
      "keeps the long serializer/response deadlines for a post-bootstrap %s node",
      role => {
        const tuning = createNodeopTuningDefaultOptions(
          node(`tuning-post-${role}`, role, RoleProducers[role]),
          true
        )
        expect(tuning).toEqual({
          ...unconditionalDefaults(),
          abiSerializerMaxTimeMs: NodeopProcess.OperatorAbiSerializerMaxTimeMs,
          httpMaxResponseTimeMs: NodeopProcess.OperatorHttpMaxResponseTimeMs
        })
        // ABSENT, not "some default": the key's absence is what makes
        // buildArgs omit the flag so nodeop's own default applies.
        expect("maxTransactionTime" in tuning).toBe(false)
      }
    )

    it.each([NodeRole.bios, NodeRole.producer])(
      "leaves ALL THREE deadlines absent for a post-bootstrap %s node",
      role => {
        const tuning = createNodeopTuningDefaultOptions(
          node(`tuning-post-${role}`, role, RoleProducers[role]),
          true
        )
        expect(tuning).toEqual(unconditionalDefaults())
        expect("maxTransactionTime" in tuning).toBe(false)
        expect("abiSerializerMaxTimeMs" in tuning).toBe(false)
        expect("httpMaxResponseTimeMs" in tuning).toBe(false)
      }
    )
  })

  describe("createRelaunchOptions", () => {
    it("pins BOTH post-bootstrap relaunch flags for every caller", () => {
      // `ClusterManager.run` and `NodeopProcessSteps.runRestart` share this ONE
      // assembly; the two flags are independent (in-bootstrap dirty-chainbase
      // recovery sets `relaunch` WITHOUT `postBootstrap`), so a call site
      // spelling them out could silently lose one.
      const relaunchNode = node("relaunch", NodeRole.producer, ["sysio"]),
        operators = [producerOperator("sysio")],
        extraArgs = ["--batch-enabled", "true"]
      expect(
        NodeopProcess.createRelaunchOptions(relaunchNode, operators, extraArgs)
      ).toEqual({
        node: relaunchNode,
        operators,
        extraArgs,
        relaunch: true,
        postBootstrap: true
      })
    })

    it("carries the post-bootstrap deadline arm into the built argv", () => {
      // The end-to-end consequence: resolving the returned options must drop
      // --max-transaction-time on a producer, exactly like an explicit
      // postBootstrap:true would.
      const args = NodeopProcess.buildArgs(
        NodeopProcess.resolveConfig(
          NodeopProcess.createRelaunchOptions(
            node("relaunch-args", NodeRole.producer, ["sysio"]),
            [producerOperator("sysio")],
            []
          ),
          {
            genesisTimestamp: "2026-01-01T00:00:00.000",
            supportsTraceNoAbis: false
          }
        )
      )
      expect(args).not.toContain(MaxTransactionTimeFlag)
      expect(valuesOf(args, AbiSerializerMaxTimeFlag)).toEqual([])
    })
  })

  describe("database map mode (SHARED-28)", () => {
    it("is an identity-mapped string enum (value === key)", () => {
      expect(DatabaseMapMode.mapped).toBe("mapped")
      expect(DatabaseMapMode.mapped_private).toBe("mapped_private")
      expect(DatabaseMapMode.heap).toBe("heap")
      expect(DatabaseMapMode.locked).toBe("locked")
    })

    it("defaults to mapped_private", () => {
      expect(NodeopProcess.DefaultDatabaseMapMode).toBe(
        DatabaseMapMode.mapped_private
      )
    })

    // EVERY nodeop node carries the flag, whatever its role — a role-conditional
    // map mode is precisely the defect this pins. Driven off `NodeRole` so a new
    // role is covered by construction rather than by remembering to add a case.
    it.each(Object.values(NodeRole))(
      "pins mapped_private on a %s node",
      async role => {
        const nodeop = await NodeopProcess.create(manager, {
            node: node(`map-mode-${role}`, role, RoleProducers[role]),
            operators: [producerOperator("sysio")]
          }),
          flagIndex = nodeop.args.indexOf(DatabaseMapModeFlag)
        // Index-adjacency, not `arrayContaining`: the flag must be followed by
        // its value, not merely accompanied by it somewhere in the argv.
        expect(flagIndex).toBeGreaterThanOrEqual(0)
        expect(nodeop.args[flagIndex + 1]).toBe(DatabaseMapMode.mapped_private)
      }
    )

    // …and on BOTH launch forms. SHARED-28 is phase-blind, so the adjacency
    // above must hold post-bootstrap too — the phase arm only governs the three
    // deadlines, and a map mode that fell into it would be silently dropped.
    it.each([false, true])(
      "pins mapped_private on BOTH launch forms (postBootstrap=%s)",
      async postBootstrap => {
        const nodeop = await NodeopProcess.create(manager, {
            node: node(
              `map-mode-phase-${String(postBootstrap)}`,
              NodeRole.producer,
              ["sysio"]
            ),
            operators: [producerOperator("sysio")],
            postBootstrap
          }),
          flagIndex = nodeop.args.indexOf(DatabaseMapModeFlag)
        expect(flagIndex).toBeGreaterThanOrEqual(0)
        expect(nodeop.args[flagIndex + 1]).toBe(DatabaseMapMode.mapped_private)
        expect(valuesOf(nodeop.args, DatabaseMapModeFlag)).toEqual([
          DatabaseMapMode.mapped_private
        ])
      }
    )
  })

  describe("chain-state DB size (SHARED-31)", () => {
    /** The chain-state DB size flag, exactly as `buildArgs` emits it. */
    const ChainStateDbSizeFlag = "--chain-state-db-size-mb"

    // UNIFORM: every role, both commands, both phases — a role- or
    // phase-conditional size is precisely the defect this pins. Driven off
    // `NodeRole` so a new role is covered by construction.
    it.each(Object.values(NodeRole))(
      "emits the default 1024 MiB on a %s node",
      async role => {
        const nodeop = await NodeopProcess.create(manager, {
            node: node(`db-size-${role}`, role, RoleProducers[role]),
            operators: [producerOperator("sysio")]
          }),
          flagIndex = nodeop.args.indexOf(ChainStateDbSizeFlag)
        // Index-adjacency, not `arrayContaining`: the flag must be followed by
        // its value, not merely accompanied by it somewhere in the argv.
        expect(flagIndex).toBeGreaterThanOrEqual(0)
        expect(nodeop.args[flagIndex + 1]).toBe(
          String(DefaultChainStateDbSizeMb)
        )
        expect(DefaultChainStateDbSizeMb).toBe(1_024)
      }
    )

    it.each([false, true])(
      "emits it on BOTH launch forms (postBootstrap=%s)",
      async postBootstrap => {
        const nodeop = await NodeopProcess.create(manager, {
          node: node(
            `db-size-phase-${String(postBootstrap)}`,
            NodeRole.producer,
            ["sysio"]
          ),
          operators: [producerOperator("sysio")],
          postBootstrap
        })
        expect(valuesOf(nodeop.args, ChainStateDbSizeFlag)).toEqual([
          String(DefaultChainStateDbSizeMb)
        ])
      }
    )

    it("takes an overridden CLUSTER value, not a per-instance tuning knob", async () => {
      // Uniformity is the ticket's point: the value is read off the cluster
      // config so every node of a cluster carries the same one.
      const oversized = fixtureConfig({
          clusterPath: dir,
          dataPath: Path.join(dir, "data"),
          executables: { ...PersistedFixture.executables, nodeop: "/bin/true" },
          chainStateDbSizeMb: 2_048
        }),
        nodeop = await NodeopProcess.create(manager, {
          node: new NodeConfig(
            oversized,
            NodeRole.batch_operator,
            0,
            "db-size-override",
            // The fixture's ALREADY-RESOLVED batch pair — a replayed binding,
            // not a fresh port (the sanctioned carve-out).
            oversized.bind.nodeop.ports.batch[0],
            [],
            []
          )
        })
      expect(valuesOf(nodeop.args, ChainStateDbSizeFlag)).toEqual(["2048"])
    })
  })

  it("derives the loopback peer allowance from the cluster topology", async () => {
    const nodeop = await NodeopProcess.create(manager, {
      node: node("peered", NodeRole.batch_operator)
    })
    // 1 producer node + 3 batch ops + 1 underwriter + bios + ad-hoc headroom
    const allowance =
      1 + 3 + 1 + NodeConfig.BiosNodeCount + NodeConfig.AdHocDaemonPeerHeadroom
    expect(nodeop.args).toEqual(
      expect.arrayContaining(["--p2p-max-nodes-per-host", String(allowance)])
    )
  })

  it("caps max-clients at the SAME topology-derived peer capacity", async () => {
    // A fixed cap below the mesh size makes each node refuse the surplus
    // inbound dials; the mesh never forms and LIB freezes at scale.
    const nodeop = await NodeopProcess.create(manager, {
      node: node("meshed", NodeRole.batch_operator)
    })
    const allowance =
      1 + 3 + 1 + NodeConfig.BiosNodeCount + NodeConfig.AdHocDaemonPeerHeadroom
    expect(nodeop.args).toEqual(
      expect.arrayContaining(["--max-clients", String(allowance)])
    )
  })

  it("buildRelaunchArgs strips genesis flags + adds enable-stale-production", () => {
    const relaunch = NodeopProcess.buildRelaunchArgs([
      "--genesis-json",
      "/g.json",
      "--genesis-timestamp",
      "2026",
      "--data-dir",
      "/d"
    ])
    expect(relaunch).not.toContain("--genesis-json")
    expect(relaunch).not.toContain("--genesis-timestamp")
    expect(relaunch).not.toContain("/g.json")
    expect(relaunch).toEqual(expect.arrayContaining(["--data-dir", "/d"]))
    expect(relaunch).toContain("--enable-stale-production")
  })

  it("relaunch mode strips the one-shot genesis flags from the instance argv", async () => {
    const nodeop = await NodeopProcess.create(manager, {
      node: node("relaunched", NodeRole.batch_operator),
      relaunch: true
    })
    expect(nodeop.args).not.toContain("--genesis-json")
    expect(nodeop.args).not.toContain("--genesis-timestamp")
    // everything else survives the strip
    expect(nodeop.args).toEqual(
      expect.arrayContaining(["--plugin", "sysio::net_plugin"])
    )
  })

  describe("dirty-chainbase recovery", () => {
    /** chainbase's real abort line (`pinnable_mapped_file.cpp`). */
    const DirtyLine = '"state" database dirty flag set'

    it("DirtyChainbasePattern matches chainbase's abort line only", () => {
      expect(NodeopProcess.DirtyChainbasePattern.test(DirtyLine)).toBe(true)
      expect(
        NodeopProcess.DirtyChainbasePattern.test("Produced block 00abc... #42")
      ).toBe(false)
    })

    it("isDirtyChainbaseAbort requires an EXITED child carrying the abort line", () => {
      expect(
        NodeopProcess.isDirtyChainbaseAbort({
          isRunning: false,
          recentOutput: [DirtyLine]
        })
      ).toBe(true)
      expect(
        NodeopProcess.isDirtyChainbaseAbort({
          isRunning: true,
          recentOutput: [DirtyLine]
        })
      ).toBe(false)
      expect(
        NodeopProcess.isDirtyChainbaseAbort({
          isRunning: false,
          recentOutput: ["clean exit"]
        })
      ).toBe(false)
      expect(
        NodeopProcess.isDirtyChainbaseAbort({
          isRunning: false,
          recentOutput: []
        })
      ).toBe(false)
    })

    it("finalizerSafetyFile is <data-dir>/finalizers/safety.dat", () => {
      expect(NodeopProcess.finalizerSafetyFile("/data/node_00")).toBe(
        "/data/node_00/finalizers/safety.dat"
      )
    })

    /** Fixture aimed at a nodeop stand-in: WITHOUT --hard-replay-blockchain it
     *  aborts exactly like a dirty chainbase; WITH it, it stays up. */
    let dirtyCluster: ClusterConfig
    let readySpy: jest.SpyInstance
    beforeAll(() => {
      const fakeNodeop = Path.join(dir, "fake-dirty-nodeop")
      Fs.writeFileSync(
        fakeNodeop,
        [
          "#!/bin/bash",
          'for arg in "$@"; do',
          '  if [[ "$arg" == "--hard-replay-blockchain" ]]; then exec /bin/sleep 300; fi',
          "done",
          `echo '${DirtyLine}' >&2`,
          "exit 2"
        ].join("\n"),
        { mode: 0o755 }
      )
      dirtyCluster = fixtureConfig({
        clusterPath: dir,
        dataPath: Path.join(dir, "data"),
        executables: { ...PersistedFixture.executables, nodeop: fakeNodeop },
        bind: {
          ...PersistedFixture.bind,
          nodeop: { ...PersistedFixture.bind.nodeop, address: "0.0.0.0" }
        }
      })
      // Deterministic readiness with no HTTP server: only the hard-replay
      // relaunch (which stays up) counts as ready. The dirty first boot dies
      // instantly and fails via the dead-child fast path regardless of any
      // verify race.
      readySpy = jest
        .spyOn(NodeopProcess.prototype, "verifyReady")
        .mockImplementation(function (this: NodeopProcess) {
          return Promise.resolve(
            this.isRunning &&
              this.args.includes(NodeopProcess.HardReplayBlockchainFlag)
          )
        })
    })
    afterAll(() => {
      readySpy.mockRestore()
    })

    /** A planned operator node over the dirty-cluster fixture. */
    function dirtyNode(name: string): NodeConfig {
      return new NodeConfig(
        dirtyCluster,
        NodeRole.batch_operator,
        0,
        name,
        { http: 18888, p2p: 19876 },
        [],
        []
      )
    }

    it("startWithRecovery relaunches once with --hard-replay-blockchain and wipes the stale fsi", async () => {
      const node = dirtyNode("dirty-recovers")
      const safetyFile = NodeopProcess.finalizerSafetyFile(node.nodePath)
      Fs.mkdirSync(Path.dirname(safetyFile), { recursive: true })
      Fs.writeFileSync(safetyFile, "stale-fsi")

      const recovered = await NodeopProcess.startWithRecovery(manager, { node })
      expect(recovered.args).toContain(NodeopProcess.HardReplayBlockchainFlag)
      // The retry runs in relaunch mode — one-shot genesis flags are stale.
      expect(recovered.args).not.toContain("--genesis-json")
      expect(recovered.isRunning).toBe(true)
      expect(manager.get("dirty-recovers")).toBe(recovered)
      // The fsi lock points into the reversible blocks hard replay discards —
      // leaving it would stall finality (fsi lockout), so recovery removes it.
      expect(Fs.existsSync(safetyFile)).toBe(false)
      await recovered.kill()
    })

    it("startWithRecovery aborts recovery when the stale fsi cannot be removed", async () => {
      const node = dirtyNode("dirty-fsi-locked")
      const safetyFile = NodeopProcess.finalizerSafetyFile(node.nodePath)
      // A DIRECTORY at the fsi path defeats rmSync({ force: true })
      // deterministically (EISDIR) — the stand-in for EACCES/EIO removal
      // failures. Recovery must abort: hard-replaying with the stale fsi
      // still in place would relaunch straight back into the finality stall.
      Fs.mkdirSync(safetyFile, { recursive: true })

      await expect(
        NodeopProcess.startWithRecovery(manager, { node })
      ).rejects.toThrow(/EISDIR|is a directory/i)
      expect(Fs.existsSync(safetyFile)).toBe(true)
      // No retry happened: the first instance still owns the label and no
      // hard-replay relaunch was registered.
      const owner = manager.get("dirty-fsi-locked")
      expect(owner).not.toBeNull()
      expect(owner.args).not.toContain(NodeopProcess.HardReplayBlockchainFlag)
    })

    it("startWithRecovery rethrows a non-dirty failure without retrying or touching the fsi", async () => {
      // The outer fixture's nodeop is /bin/true: it exits cleanly with no
      // output — a startup failure that is NOT the dirty-chainbase abort.
      const cleanNode = node("clean-dies", NodeRole.batch_operator)
      const safetyFile = NodeopProcess.finalizerSafetyFile(cleanNode.nodePath)
      Fs.mkdirSync(Path.dirname(safetyFile), { recursive: true })
      Fs.writeFileSync(safetyFile, "keep-me")

      await expect(
        NodeopProcess.startWithRecovery(manager, { node: cleanNode })
      ).rejects.toThrow(/before passing verifyReady/)
      expect(Fs.existsSync(safetyFile)).toBe(true)
      // No retry: the first (failed) instance still owns the label.
      expect(manager.get("clean-dies")).not.toBeNull()
    })

    it("start() surfaces the dirty abort line in the rejection via startupFailureDetail", async () => {
      const first = await NodeopProcess.create(manager, {
        node: dirtyNode("dirty-detail")
      })
      await expect(first.start()).rejects.toThrow(/database dirty flag set/)
    })
  })

  describe("resumeProduction", () => {
    let server: Http.Server
    let requestedPath: string
    let requestedMethod: string

    afterEach(async () => {
      await new Promise<void>(resolve => server.close(() => resolve()))
    })

    it("POSTs the resume path and resolves on an OK response", async () => {
      server = Http.createServer((req, res) => {
        requestedPath = req.url
        requestedMethod = req.method
        res.writeHead(200)
        res.end()
      })
      const port = await BindConfigProvider.findAvailable(
        BindConfigProvider.DefaultBiosHttp
      )
      await new Promise<void>(resolve =>
        server.listen(port, Localhost, resolve)
      )

      await expect(
        NodeopProcess.resumeProduction(toURL(port, Localhost))
      ).resolves.toBeUndefined()
      expect(requestedMethod).toBe("POST")
      expect(requestedPath).toBe(NodeopProcess.ResumeProductionPath)
    })

    it("rejects when the endpoint answers a non-OK status", async () => {
      server = Http.createServer((_req, res) => {
        res.writeHead(503)
        res.end()
      })
      const port = await BindConfigProvider.findAvailable(
        BindConfigProvider.DefaultBiosHttp
      )
      await new Promise<void>(resolve =>
        server.listen(port, Localhost, resolve)
      )

      await expect(
        NodeopProcess.resumeProduction(toURL(port, Localhost))
      ).rejects.toThrow(/answered 503/)
    })
  })
})
