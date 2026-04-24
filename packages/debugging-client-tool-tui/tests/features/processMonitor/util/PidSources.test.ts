import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import {
  NodeRole,
  type ClusterState,
  type NodeState
} from "@wire-e2e-tests/debugging-shared"
import {
  collectPidSources,
  logPathForSource,
  PidSourceKind,
  PidSources
} from "@wire-e2e-tests/debugging-client-tool-tui/features/processMonitor/util/PidSources.js"

/** Build a minimal NodeState for a given role + nodeId, pointing at a real temp dir. */
function makeNode(
  root: string,
  subdir: string,
  role: NodeRole | undefined,
  nodeId: NodeState["nodeId"]
): NodeState {
  const dataPath = Path.join(root, "data", subdir)
  Fs.mkdirSync(dataPath, { recursive: true })
  return {
    nodeId,
    host: "127.0.0.1",
    port: 8888,
    dataPath,
    configPath: dataPath,
    cmd: [],
    isProducer: role === NodeRole.Producer,
    producerName: null,
    role
  } as NodeState
}

/** Drop `<label>.pid` file into `dir`. */
function writePid(dir: string, label: string, pid: number = 1): string {
  Fs.mkdirSync(dir, { recursive: true })
  const file = Path.join(dir, `${label}.pid`)
  Fs.writeFileSync(file, String(pid))
  return file
}

describe("collectPidSources", () => {
  let root: string

  beforeEach(() => {
    root = Fs.mkdtempSync(Path.join(Os.tmpdir(), "pid-src-"))
  })

  afterEach(() => {
    Fs.rmSync(root, { recursive: true, force: true })
  })

  it("returns empty when cluster state is null", () => {
    expect(collectPidSources(root, null)).toEqual([])
  })

  it("scans every node subdir and classifies by role", () => {
    const producer = makeNode(root, "node_00", NodeRole.Producer, 0)
    const batchop = makeNode(
      root,
      "node_batchop_00",
      NodeRole.BatchOperator,
      "batchop_00"
    )
    const underwriter = makeNode(
      root,
      "node_uwrit_00",
      NodeRole.Underwriter,
      "uwrit_00"
    )
    writePid(producer.dataPath, "node-00")
    writePid(batchop.dataPath, "node-batchop_00")
    writePid(underwriter.dataPath, "node-uwrit_00")

    const state = {
      nodes: [producer],
      batchOperatorNodes: [batchop],
      underwriterNodes: [underwriter]
    } as unknown as ClusterState

    const sources = collectPidSources(root, state)
    const map = new Map(sources.map(s => [s.label, s]))
    expect(map.get("node-00")?.kind).toBe(PidSourceKind.Producer)
    expect(map.get("node-batchop_00")?.kind).toBe(PidSourceKind.BatchOperator)
    expect(map.get("node-uwrit_00")?.kind).toBe(PidSourceKind.Underwriter)
  })

  it("bios producer nodes are classified as Bios when nodeId is 'bios'", () => {
    const bios = makeNode(root, "node_bios", NodeRole.Producer, "bios")
    writePid(bios.dataPath, "node-bios")
    const state = {
      nodes: [bios],
      batchOperatorNodes: [],
      underwriterNodes: []
    } as unknown as ClusterState
    const [source] = collectPidSources(root, state)
    expect(source.kind).toBe(PidSourceKind.Bios)
    expect(source.label).toBe("node-bios")
  })

  it("picks up anvil + solana-test-validator pid files from their subpaths", () => {
    writePid(Path.join(root, PidSources.AnvilSubpath), "anvil")
    writePid(
      Path.join(root, PidSources.SolanaSubpath),
      "solana-test-validator"
    )
    const state = {
      nodes: [],
      batchOperatorNodes: [],
      underwriterNodes: []
    } as unknown as ClusterState

    const sources = collectPidSources(root, state)
    const kinds = new Set(sources.map(s => s.kind))
    expect(kinds.has(PidSourceKind.Anvil)).toBe(true)
    expect(kinds.has(PidSourceKind.SolanaValidator)).toBe(true)
  })

  it("skips directories that don't exist and non-.pid files", () => {
    const producer = makeNode(root, "node_00", NodeRole.Producer, 0)
    writePid(producer.dataPath, "node-00")
    // Add some non-pid clutter
    Fs.writeFileSync(Path.join(producer.dataPath, "config.ini"), "x")
    Fs.writeFileSync(Path.join(producer.dataPath, "log_20260423.log"), "x")

    const state = {
      nodes: [producer],
      batchOperatorNodes: [],
      underwriterNodes: []
    } as unknown as ClusterState

    const sources = collectPidSources(root, state)
    expect(sources).toHaveLength(1)
    expect(sources[0].label).toBe("node-00")
  })
})

describe("logPathForSource", () => {
  it("builds <directory>/logs/log_<datestamp>.log", () => {
    const source = {
      label: "node-00",
      pidPath: "/tmp/x/node-00.pid",
      directory: "/tmp/x",
      kind: PidSourceKind.Producer
    }
    expect(logPathForSource(source, "20260423")).toBe(
      "/tmp/x/logs/log_20260423.log"
    )
  })
})
