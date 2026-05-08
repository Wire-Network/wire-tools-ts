import * as Fs from "node:fs"
import * as OS from "node:os"
import * as Path from "node:path"

import {
  NodeRole,
  PidSourceKind,
  PidSources,
  collectPidSources,
  logPathForSource,
  pidIsAlive,
  readPid,
  type ClusterState,
  type NodeState
} from "@wireio/debugging-shared"

describe("collectPidSources", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = Fs.mkdtempSync(Path.join(OS.tmpdir(), "pidsources-"))
  })

  afterEach(() => {
    Fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("returns [] when state is null", () => {
    expect(collectPidSources(tmpDir, null)).toEqual([])
  })

  it("classifies bios / producer / batch-operator / underwriter / anvil / solana", () => {
    const biosDir = Path.join(tmpDir, "data", "node_bios"),
      producerDir = Path.join(tmpDir, "data", "node_p1"),
      batchDir = Path.join(tmpDir, "data", "node_b1"),
      underwriterDir = Path.join(tmpDir, "data", "node_u1"),
      anvilDir = Path.join(tmpDir, PidSources.AnvilSubpath),
      solanaDir = Path.join(tmpDir, PidSources.SolanaSubpath)

    ;[biosDir, producerDir, batchDir, underwriterDir, anvilDir, solanaDir].forEach(d =>
      Fs.mkdirSync(d, { recursive: true })
    )

    Fs.writeFileSync(Path.join(biosDir, "nodeop.pid"), "11", "utf8")
    Fs.writeFileSync(Path.join(producerDir, "nodeop.pid"), "12", "utf8")
    Fs.writeFileSync(Path.join(batchDir, "nodeop.pid"), "13", "utf8")
    Fs.writeFileSync(Path.join(underwriterDir, "nodeop.pid"), "14", "utf8")
    Fs.writeFileSync(Path.join(anvilDir, "anvil.pid"), "15", "utf8")
    Fs.writeFileSync(
      Path.join(solanaDir, "solana-test-validator.pid"),
      "16",
      "utf8"
    )

    const node = (
      nodeId: string | number,
      dataPath: string,
      role: NodeRole | undefined
    ): NodeState => ({
      nodeId,
      host: "127.0.0.1",
      port: 0,
      dataPath,
      configPath: "",
      cmd: [],
      isProducer: role === undefined,
      producerName: null,
      role
    })

    const state: ClusterState = {
      pnodes: 1,
      totalNodes: 4,
      prodCount: 1,
      topo: "mesh",
      nodes: [
        node(PidSources.BiosNodeId, biosDir, NodeRole.Producer),
        node(1, producerDir, NodeRole.Producer)
      ],
      batchOperatorNodes: [node(1, batchDir, NodeRole.BatchOperator)],
      underwriterNodes: [node(1, underwriterDir, NodeRole.Underwriter)],
      anvilStatePath: "",
      solanaLedgerPath: "",
      walletPath: ""
    }

    const sources = collectPidSources(tmpDir, state),
      kindsByLabel = Object.fromEntries(sources.map(s => [s.label, s.kind]))

    expect(kindsByLabel["nodeop"]).toBeDefined()
    // labels collide ("nodeop") so check kind set instead
    const kinds = sources.map(s => s.kind).sort()
    expect(kinds).toEqual(
      [
        PidSourceKind.Anvil,
        PidSourceKind.BatchOperator,
        PidSourceKind.Bios,
        PidSourceKind.Producer,
        PidSourceKind.SolanaValidator,
        PidSourceKind.Underwriter
      ].sort()
    )
  })
})

describe("logPathForSource", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = Fs.mkdtempSync(Path.join(OS.tmpdir(), "logpath-"))
  })

  afterEach(() => {
    Fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("prefers the lex-latest .jsonl in the logs subdir", () => {
    const logsDir = Path.join(tmpDir, PidSources.LogsSubdir)
    Fs.mkdirSync(logsDir, { recursive: true })
    Fs.writeFileSync(Path.join(logsDir, "log_2026-04-27.jsonl"), "")
    Fs.writeFileSync(Path.join(logsDir, "log_2026-05-08.jsonl"), "")
    const path = logPathForSource({
      label: "nodeop",
      pidPath: "",
      directory: tmpDir,
      kind: PidSourceKind.Producer
    })
    expect(path).toBe(Path.join(logsDir, "log_2026-05-08.jsonl"))
  })

  it("falls back to log_<datestamp>.log when no jsonl present", () => {
    const path = logPathForSource(
      {
        label: "anvil",
        pidPath: "",
        directory: tmpDir,
        kind: PidSourceKind.Anvil
      },
      new Date(2026, 4, 8)
    )
    expect(path).toBe(
      Path.join(tmpDir, PidSources.LogsSubdir, "log_20260508.log")
    )
  })
})

describe("readPid", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = Fs.mkdtempSync(Path.join(OS.tmpdir(), "readpid-"))
  })

  afterEach(() => {
    Fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("returns the parsed positive integer", () => {
    const p = Path.join(tmpDir, "x.pid")
    Fs.writeFileSync(p, "1234\n", "utf8")
    expect(readPid(p)).toBe(1234)
  })

  it("returns null when the file is missing", () => {
    expect(readPid(Path.join(tmpDir, "missing.pid"))).toBeNull()
  })

  it("returns null on malformed contents", () => {
    const p = Path.join(tmpDir, "bad.pid")
    Fs.writeFileSync(p, "not a number\n", "utf8")
    expect(readPid(p)).toBeNull()
  })

  it("returns null for non-positive pids", () => {
    const p = Path.join(tmpDir, "zero.pid")
    Fs.writeFileSync(p, "0\n", "utf8")
    expect(readPid(p)).toBeNull()
  })
})

describe("pidIsAlive", () => {
  it("returns false for null pid", () => {
    expect(pidIsAlive(null)).toBe(false)
  })

  it("returns true for the current process pid", () => {
    expect(pidIsAlive(process.pid)).toBe(true)
  })

  it("returns false for an obviously-dead pid", () => {
    // 99999999 is well beyond default kernel.pid_max on Linux test VMs
    expect(pidIsAlive(99999999)).toBe(false)
  })
})
