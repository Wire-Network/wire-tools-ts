import * as Fs from "node:fs"
import * as OS from "node:os"
import * as Path from "node:path"

import {
  ClusterStateNodeRole,
  type ClusterState,
  type ClusterStateNode
} from "@wireio/cluster-tool-shared"
import {
  PidSourceKind,
  PidSources,
  collectPidSources,
  logPathForSource,
  pidIsAlive,
  readPid
} from "@wireio/debugging-shared"

describe("collectPidSources", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = Fs.mkdtempSync(Path.join(OS.tmpdir(), "pidsources-"))
  })

  afterEach(() => {
    Fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  /**
   * A `cluster-state.json` node row; the scanner reads only its role, labels,
   * and path — its ports are unread placeholders, never a binding.
   */
  const node = (
    name: string,
    nodePath: string,
    role: ClusterStateNodeRole,
    batchOperatorLabel: string | null = null,
    underwriterLabel: string | null = null
  ): ClusterStateNode => ({
    name,
    role,
    nodePath,
    ports: { http: 0, p2p: 0 },
    producers: [],
    batchOperatorLabel,
    underwriterLabel
  })

  /** A `cluster-state.json` snapshot over `nodes` (no anvil / solana state to scan). */
  const stateOf = (nodes: ClusterStateNode[]): ClusterState => ({
    createdAt: new Date().toISOString(),
    nodes,
    walletPath: "",
    anvilStateFile: "",
    solanaLedgerPath: "",
    solanaIdlFile: null
  })

  it("returns [] when state is null", () => {
    expect(collectPidSources(tmpDir, null)).toEqual([])
  })

  it("classifies bios / producer / batch operator / underwriter / api / anvil / solana", () => {
    const biosDir = Path.join(tmpDir, "data", "bios"),
      producerDir = Path.join(tmpDir, "data", "node_00"),
      batchDir = Path.join(tmpDir, "data", "node_01"),
      underwriterDir = Path.join(tmpDir, "data", "node_02"),
      apiDir = Path.join(tmpDir, "data", "node_03"),
      anvilDir = Path.join(tmpDir, PidSources.AnvilSubpath),
      solanaDir = Path.join(tmpDir, PidSources.SolanaSubpath)

    ;[
      biosDir,
      producerDir,
      batchDir,
      underwriterDir,
      apiDir,
      anvilDir,
      solanaDir
    ].forEach(d => Fs.mkdirSync(d, { recursive: true }))

    Fs.writeFileSync(Path.join(biosDir, "nodeop.pid"), "11", "utf8")
    Fs.writeFileSync(Path.join(producerDir, "nodeop.pid"), "12", "utf8")
    Fs.writeFileSync(Path.join(batchDir, "nodeop.pid"), "13", "utf8")
    Fs.writeFileSync(Path.join(underwriterDir, "nodeop.pid"), "14", "utf8")
    Fs.writeFileSync(Path.join(apiDir, "nodeop.pid"), "17", "utf8")
    Fs.writeFileSync(Path.join(anvilDir, "anvil.pid"), "15", "utf8")
    Fs.writeFileSync(
      Path.join(solanaDir, "solana-test-validator.pid"),
      "16",
      "utf8"
    )

    const state = stateOf([
      node(PidSources.BiosNodeId, biosDir, ClusterStateNodeRole.bios),
      node("node_00", producerDir, ClusterStateNodeRole.producer),
      node("node_01", batchDir, ClusterStateNodeRole.operator, "batchop1"),
      node(
        "node_02",
        underwriterDir,
        ClusterStateNodeRole.operator,
        null,
        "underwriter1"
      ),
      node("node_03", apiDir, ClusterStateNodeRole.api)
    ])

    const sources = collectPidSources(tmpDir, state),
      kindsByLabel = Object.fromEntries(sources.map(s => [s.label, s.kind]))

    expect(kindsByLabel["nodeop"]).toBeDefined()
    // labels collide ("nodeop") so check kind set instead
    const kinds = sources.map(s => s.kind).sort()
    expect(kinds).toEqual(
      [
        PidSourceKind.anvil,
        PidSourceKind.api,
        PidSourceKind.batch_operator,
        PidSourceKind.bios,
        PidSourceKind.producer,
        PidSourceKind.solana_validator,
        PidSourceKind.underwriter
      ].sort()
    )
  })

  it("classifies an api node as PidSourceKind.api", () => {
    // Labelled the way ManagedProcess writes a nodeop pid file
    // (`<nodePath>/<label>.pid`), so the api node's source is found by label.
    const apiLabel = "node_05",
      apiDir = Path.join(tmpDir, "data", apiLabel)
    Fs.mkdirSync(apiDir, { recursive: true })
    Fs.writeFileSync(
      Path.join(apiDir, `${apiLabel}${PidSources.PidExt}`),
      "21",
      "utf8"
    )
    const apiNode = node(apiLabel, apiDir, ClusterStateNodeRole.api),
      source = collectPidSources(tmpDir, stateOf([apiNode])).find(
        candidate => candidate.label === apiLabel
      )
    expect(source).toBeDefined()
    expect(source.kind).toBe(PidSourceKind.api)
    expect(source.node).toEqual(apiNode)
    expect(source.directory).toBe(apiDir)
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
      kind: PidSourceKind.producer
    })
    expect(path).toBe(Path.join(logsDir, "log_2026-05-08.jsonl"))
  })

  it("falls back to log_<datestamp>.log when no jsonl present", () => {
    const path = logPathForSource(
      {
        label: "anvil",
        pidPath: "",
        directory: tmpDir,
        kind: PidSourceKind.anvil
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
