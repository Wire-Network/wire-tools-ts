import { spawn } from "node:child_process"
import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import {
  AWSAccountName,
  ClusterFiles,
  SignatureProviderType,
  type ClusterConfig,
  type ExternalOutpostConfig
} from "@wireio/cluster-tool-shared"
import { PidSources } from "@wireio/debugging-shared"
import { Deferred, guard } from "@wireio/shared"
import { ClusterManager, ClusterState } from "@wireio/cluster-tool"
import { WireWallet } from "@wireio/cluster-tool/clients/wire"
import {
  NodeopProcess,
  ProcessSignalName
} from "@wireio/cluster-tool/cluster/processes"
import {
  BindConfigProvider,
  ClusterConfigProvider,
  NodeConfig,
  NodeRole,
  SSMClientProvider
} from "@wireio/cluster-tool/config"
import { Steps } from "@wireio/cluster-tool/orchestration"
import { fixtureConfig } from "../config/clusterConfigFixture.js"

const mockSend = jest.fn()
// A DeleteParameterCommand that EXPLODES if anything ever constructs one — the
// mock itself is the tripwire for a regression that re-introduces deletion.
const mockDeleteParameterCommand = jest.fn().mockImplementation(() => {
  throw new Error("destroy must NEVER construct a DeleteParameterCommand")
})
jest.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  GetParameterCommand: jest
    .fn()
    .mockImplementation((input: unknown) => ({ kind: "GetParameter", input })),
  PutParameterCommand: jest
    .fn()
    .mockImplementation((input: unknown) => ({ kind: "PutParameter", input })),
  DeleteParameterCommand: mockDeleteParameterCommand
}))

describe("ClusterManager.assertClusterStopped", () => {
  let dir: string

  beforeEach(() => {
    dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "cluster-manager-"))
  })

  afterEach(() => {
    Fs.rmSync(dir, { recursive: true, force: true })
  })

  /** A `ClusterConfig` rooted at the temp dir, with `dataPath` pointed at `dataPath`. */
  function configWithDataPath(dataPath: string) {
    return fixtureConfig({ clusterPath: dir, dataPath })
  }

  it("passes when the data dir does not exist", () => {
    expect(() =>
      ClusterManager.assertClusterStopped(configWithDataPath(Path.join(dir, "data")))
    ).not.toThrow()
  })

  it("passes when a pidfile is stale (its pid is no longer alive)", () => {
    const dataPath = Path.join(dir, "data"),
      nodeDirectory = Path.join(dataPath, "node_bios")
    Fs.mkdirSync(nodeDirectory, { recursive: true })
    // A pid number far past any real pid — guaranteed not alive (ESRCH).
    Fs.writeFileSync(Path.join(nodeDirectory, "node_bios.pid"), "987654321")
    expect(() => ClusterManager.assertClusterStopped(configWithDataPath(dataPath))).not.toThrow()
  })

  it("throws, naming the live pid, when a pidfile points at a still-running process", async () => {
    const child = spawn("/bin/sleep", ["300"], { stdio: "ignore" })
    try {
      const dataPath = Path.join(dir, "data"),
        nodeDirectory = Path.join(dataPath, "node_bios")
      Fs.mkdirSync(nodeDirectory, { recursive: true })
      Fs.writeFileSync(Path.join(nodeDirectory, "node_bios.pid"), String(child.pid))
      expect(() =>
        ClusterManager.assertClusterStopped(configWithDataPath(dataPath))
      ).toThrow(new RegExp(`live pid\\(s\\): ${child.pid}`))
    } finally {
      child.kill("SIGKILL")
      await new Promise<void>(resolve => child.once("exit", () => resolve()))
    }
  })
})

describe("ClusterManager.prepareClusterPath", () => {
  /** Node dir seeded under the cluster's data dir — the shape the scan walks. */
  const NodeName = "node_bios"
  /** Written into the cluster dir; its survival IS the "no wipe" assertion. */
  const MarkerFilename = "marker.txt"
  const MarkerContent = "pre-existing cluster content"
  /** A pid far past any real pid — guaranteed not alive (ESRCH). */
  const StalePid = 987_654_321

  let root: string, clusterPath: string, markerFile: string

  /**
   * A LIVE pid with a real child behind it (never incidental process
   * ancestry). It blocks on its stdin pipe, so it lives EXACTLY as long as
   * this worker: afterAll kills it on the normal path, and if the worker dies
   * any other way the pipe EOF drains its event loop and it exits on its own.
   * Deliberately NOT unref'd — a failed reap must show up as a leaked handle.
   */
  let liveChild: ReturnType<typeof spawn>

  beforeAll(() => {
    liveChild = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
      stdio: ["pipe", "ignore", "ignore"]
    })
    expect(liveChild.pid).toBeGreaterThan(0)
  })

  afterAll(async () => {
    // Await "close" (exit + stdio teardown), not "exit": the stdin pipe socket
    // and the child handle must be FULLY gone before the worker tears down.
    const closed = Deferred.useCallback<void>(deferred => {
      if (liveChild.exitCode != null || liveChild.signalCode != null) {
        deferred.resolve()
        return
      }
      liveChild.once("close", () => deferred.resolve())
    }).promise
    liveChild.stdin.destroy()
    // Best-effort signal — ESRCH if the child already exited.
    guard(() => process.kill(liveChild.pid, ProcessSignalName.SIGKILL))
    await closed
  })

  beforeEach(() => {
    root = Fs.mkdtempSync(Path.join(Os.tmpdir(), "cluster-manager-force-"))
    clusterPath = Path.join(root, "cluster")
    markerFile = Path.join(clusterPath, MarkerFilename)
    Fs.mkdirSync(clusterPath, { recursive: true })
    Fs.writeFileSync(markerFile, MarkerContent)
  })

  afterEach(() => {
    Fs.rmSync(root, { recursive: true, force: true })
  })

  /** Seed a pidfile exactly where the live-pid scan looks: `data/<node>/<node>.pid`. */
  function writePidFile(pid: number): void {
    const nodeDirectory = Path.join(
      clusterPath,
      ClusterConfigProvider.DataSubpath,
      NodeName
    )
    Fs.mkdirSync(nodeDirectory, { recursive: true })
    Fs.writeFileSync(
      Path.join(nodeDirectory, `${NodeName}${PidSources.PidExt}`),
      String(pid)
    )
  }

  it("removes the pre-existing cluster path when force is set", () => {
    ClusterManager.prepareClusterPath({ force: true, clusterPath })
    expect(Fs.existsSync(markerFile)).toBe(false)
    expect(Fs.existsSync(clusterPath)).toBe(false)
  })

  it("removes it when every pidfile is stale", () => {
    writePidFile(StalePid)
    ClusterManager.prepareClusterPath({ force: true, clusterPath })
    expect(Fs.existsSync(clusterPath)).toBe(false)
  })

  it("REFUSES an existing path without force, leaving it untouched", () => {
    // Never a silent overlay: the previous cluster's block logs, chain state
    // and stale pidfiles would be inherited under a freshly written genesis.
    expect(() => ClusterManager.prepareClusterPath({ clusterPath })).toThrow(
      /already exists .* pass --force to replace it/
    )
    expect(() =>
      ClusterManager.prepareClusterPath({ force: false, clusterPath })
    ).toThrow(/already exists .* pass --force to replace it/)
    expect(Fs.existsSync(markerFile)).toBe(true)
    expect(Fs.readFileSync(markerFile, "utf8")).toBe(MarkerContent)
  })

  it("refuses to remove a cluster whose pidfile names a LIVE pid", () => {
    writePidFile(liveChild.pid)
    expect(() =>
      ClusterManager.prepareClusterPath({ force: true, clusterPath })
    ).toThrow(new RegExp(`live pid\\(s\\): ${liveChild.pid}`))
    expect(Fs.existsSync(markerFile)).toBe(true)
  })

  it("is a no-op when the cluster path does not exist — with or without force", () => {
    const missing = Path.join(root, "never-created")
    expect(() =>
      ClusterManager.prepareClusterPath({ force: true, clusterPath: missing })
    ).not.toThrow()
    expect(() =>
      ClusterManager.prepareClusterPath({ clusterPath: missing })
    ).not.toThrow()
    expect(Fs.existsSync(missing)).toBe(false)
  })
})

// ProcessManager.setClusterPath is once-per-process (idempotent for the same
// value), so every destroy() and run() in this file must target the SAME
// cluster root.
const pinnedClusterRoot = Fs.mkdtempSync(
  Path.join(Os.tmpdir(), "cluster-manager-pinned-")
)

describe("ClusterManager.destroy", () => {
  /** The shared-root `ClusterConfig`, its dataPath laid out like a real cluster. */
  function destroyConfig() {
    return fixtureConfig({
      clusterPath: pinnedClusterRoot,
      dataPath: Path.join(pinnedClusterRoot, "data")
    })
  }

  beforeEach(() => {
    Fs.mkdirSync(Path.join(pinnedClusterRoot, "data", "node_bios"), { recursive: true })
  })

  afterAll(() => {
    Fs.rmSync(pinnedClusterRoot, { recursive: true, force: true })
  })

  it("sets the process-manager cluster path itself and removes the cluster directory", async () => {
    await expect(ClusterManager.destroy(destroyConfig())).resolves.toBeUndefined()
    expect(Fs.existsSync(pinnedClusterRoot)).toBe(false)
  })

  it("prunes a stale pidfile via the orphan sweep and still removes the directory", async () => {
    // A pid number far past any real pid — guaranteed not alive (ESRCH).
    Fs.writeFileSync(
      Path.join(pinnedClusterRoot, "data", "node_bios", "node_bios.pid"),
      "987654321"
    )
    await expect(ClusterManager.destroy(destroyConfig())).resolves.toBeUndefined()
    expect(Fs.existsSync(pinnedClusterRoot)).toBe(false)
  })

  describe("D21 — destroy NEVER deletes an SSM secret", () => {
    /** Every region a key is replicated to (no primary). */
    const SSMRegions = ["us-east-1", "eu-west-1"]

    /** The shared-root config, resolved under an SSM signature provider. */
    function ssmDestroyConfig(overrides: Partial<ClusterConfig> = {}) {
      return fixtureConfig({
        clusterPath: pinnedClusterRoot,
        dataPath: Path.join(pinnedClusterRoot, "data"),
        signatureProvider: {
          type: SignatureProviderType.SSM,
          ssm: {
            awsRegions: SSMRegions,
            awsSecretIdPattern: "/wire/{cluster}/{account}/{keyType}"
          }
        },
        awsClusterNodeConfig: {
          account: AWSAccountName.test,
          regions: SSMRegions,
          ssm: null
        },
        ...overrides
      })
    }

    beforeEach(() => {
      mockSend.mockReset()
      mockDeleteParameterCommand.mockClear()
    })

    it("issues ZERO DeleteParameter calls — a published parameter is the account's key identity", async () => {
      await expect(
        ClusterManager.destroy(ssmDestroyConfig())
      ).resolves.toBeUndefined()
      // Nothing was constructed, and nothing was sent to AWS at all.
      expect(mockDeleteParameterCommand).not.toHaveBeenCalled()
      expect(mockSend).not.toHaveBeenCalled()
      expect(Fs.existsSync(pinnedClusterRoot)).toBe(false)
    })

    it("the provider exposes no delete surface for a regression to reach for", () => {
      expect(SSMClientProvider).not.toHaveProperty("deleteParameter")
    })

    it("removes the cluster directory even with NO cluster-keys.json", async () => {
      expect(
        Fs.existsSync(Path.join(pinnedClusterRoot, ClusterFiles.KeysFilename))
      ).toBe(false)
      await expect(
        ClusterManager.destroy(ssmDestroyConfig())
      ).resolves.toBeUndefined()
      expect(Fs.existsSync(pinnedClusterRoot)).toBe(false)
    })

    it("removes the cluster directory even when the ids cannot be rendered", async () => {
      // A half-built cluster: `create` aborted before the AWS placement
      // resolved, so `signatureProviderKeyPublications` throws. The guarded
      // rendering must degrade to a warning, never strand the directory.
      await expect(
        ClusterManager.destroy(ssmDestroyConfig({ awsClusterNodeConfig: null }))
      ).resolves.toBeUndefined()
      expect(Fs.existsSync(pinnedClusterRoot)).toBe(false)
    })
  })
})

describe("ClusterManager.run", () => {
  /**
   * The call-log entry each `resumeProduction` records — a node start records
   * that node's name instead.
   */
  const ResumeProductionEvent = "resume-production"

  /**
   * An already-deployed outpost description. Only its presence matters: it
   * selects external-outpost mode, and every reader of the files it names is
   * stubbed below.
   */
  const ExternalOutposts: ExternalOutpostConfig = {
    ethereum: {
      addressFile: "/ext/outpost-addrs.json",
      abiFiles: ["/ext/eth-abis/OPP.json"],
      chainId: 11_155_111
    },
    solana: { idlFile: "/ext/solana-idls/liqsol_core.json" }
  }

  afterEach(() => {
    jest.restoreAllMocks()
  })

  afterAll(() => {
    Fs.rmSync(pinnedClusterRoot, { recursive: true, force: true })
  })

  it("starts API nodes after every producer and before production resumes, operators after it resumes", async () => {
    // External-outpost mode with the debugging server off narrows the relaunch
    // to its nodeop waves: no local anvil / validator, no epoch-advance gate.
    const config = fixtureConfig({
        clusterPath: pinnedClusterRoot,
        dataPath: Path.join(pinnedClusterRoot, "data"),
        externalOutposts: ExternalOutposts,
        debuggingServerEnabled: false
      }),
      order: string[] = []
    // `run` reloads the keys `create` persisted; an empty set suffices because
    // operator resolution is stubbed below.
    Fs.mkdirSync(pinnedClusterRoot, { recursive: true })
    ClusterState.saveKeys(config, { nodes: [], operators: [] })
    // Every other seam would probe host ports, spawn a daemon, or dial a
    // chain; the start + resume spies record the call order under test.
    jest.spyOn(BindConfigProvider, "validate").mockResolvedValue(true)
    jest
      .spyOn(BindConfigProvider, "registerResolved")
      .mockReturnValue(undefined)
    jest.spyOn(Steps.processes.kiod, "runStart").mockResolvedValue(undefined)
    jest.spyOn(WireWallet.prototype, "unlock").mockResolvedValue(undefined)
    jest.spyOn(Steps.processes.nodeop, "resolveOperators").mockReturnValue([])
    jest
      .spyOn(Steps.processes.nodeop, "resolveOperatorDaemonArgs")
      .mockReturnValue([])
    jest
      .spyOn(NodeopProcess, "startWithRecovery")
      .mockImplementation(async (_manager, options) => {
        order.push(options.node.name)
        // strictNullChecks is off — `run` never reads the resolved process.
        return undefined
      })
    jest
      .spyOn(NodeopProcess, "resumeProduction")
      .mockImplementation(async () => {
        order.push(ResumeProductionEvent)
      })
    jest
      .spyOn(Steps.externalOutpost, "runHeadBlockAdvance")
      .mockResolvedValue(undefined)
    jest
      .spyOn(Steps.externalOutpost, "runPublishArtifacts")
      .mockResolvedValue(undefined)

    await ClusterManager.run(config)

    const nodes = NodeConfig.plan(config),
      startsOf = (predicate: (node: NodeConfig) => boolean) =>
        nodes.filter(predicate).map(node => order.indexOf(node.name)),
      producerStarts = startsOf(node => node.role === NodeRole.producer),
      apiStarts = startsOf(node => node.role === NodeRole.api),
      operatorStarts = startsOf(node => NodeConfig.isOperatorRole(node.role))
    // Positive controls: every planned node started, production resumed, and
    // no compared wave is empty — otherwise the orderings hold vacuously.
    expect(order).toEqual(expect.arrayContaining(nodes.map(node => node.name)))
    expect(order).toContain(ResumeProductionEvent)
    expect(producerStarts).not.toHaveLength(0)
    expect(apiStarts).not.toHaveLength(0)
    expect(operatorStarts).not.toHaveLength(0)

    expect(Math.min(...apiStarts)).toBeGreaterThan(Math.max(...producerStarts))
    expect(Math.max(...apiStarts)).toBeLessThan(
      order.indexOf(ResumeProductionEvent)
    )
    expect(Math.min(...operatorStarts)).toBeGreaterThan(
      order.lastIndexOf(ResumeProductionEvent)
    )
  })
})
