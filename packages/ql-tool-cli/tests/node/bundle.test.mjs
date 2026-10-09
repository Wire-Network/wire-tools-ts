// Bundle-level smoke tests of dist/bundle/wql.mjs (run by `test:unit` after `bundle`):
// the shipped bins, real yargs, golden output per format against a node:http stub
// on a registry-issued port, exit codes, and real per-file logger categories.
import Assert from "node:assert/strict"
import { spawn } from "node:child_process"
import Fs from "node:fs"
import Http from "node:http"
import { createRequire } from "node:module"
import Os from "node:os"
import Path from "node:path"
import { after, before, describe, it } from "node:test"

const PackagePath = Path.resolve(import.meta.dirname, "..", ".."),
  RepositoryRoot = Path.resolve(PackagePath, "..", ".."),
  BundlePath = Path.join(PackagePath, "dist", "bundle"),
  WqlBin = Path.join(PackagePath, "bin", "wql"),
  TuiBin = Path.join(PackagePath, "bin", "wire-ql-tui"),
  Sandbox = Fs.mkdtempSync(Path.join(Os.tmpdir(), "wql-bundle-test-"))

// Sandbox the bind registry and the wql stores BEFORE cluster-tool loads. The
// workspace / @wireio packages are loaded through require (their CommonJS builds;
// the hybrid packages' ESM builds are not loadable by native ESM).
process.env.WIRE_BIND_REGISTRY_PATH = Path.join(Sandbox, "bind-registry")
Fs.mkdirSync(process.env.WIRE_BIND_REGISTRY_PATH, { recursive: true })
const require = createRequire(import.meta.url),
  { BindConfigProvider, Localhost, toURL } = require("@wireio/cluster-tool"),
  { JsonRPCProtocol } = require("@wireio/cluster-tool-shared"),
  { OutputFormat, ResultRenderer, ResultView, QueryEngineRPC } = require("@wireio/ql-shared"),
  { filenameCategoryInterpolator } = require("@wireio/shared")

/** The result every stub request answers with (2 of 5 rows; more available). */
const Result = {
  schema_version: QueryEngineRPC.SchemaVersion,
  complete: true,
  source: { owners: ["sample"], table: "positions" },
  state: {
    chain_id: "a".repeat(64),
    block_id: "b".repeat(64),
    block_num: "42",
    block_time: "2026-09-21T12:00:00.000",
    read_mode: "head",
    last_irreversible_block_num: "40",
    abis: [],
    captured_at: "2026-09-21T12:00:00.050000Z",
    synced: true
  },
  columns: [
    { name: "id", logical_type: "integer", abi_type: "uint64", nullable: false, encoding: "decimal_string" },
    { name: "name", logical_type: "text", abi_type: "string", nullable: true, encoding: "text" }
  ],
  rows: [
    { id: "1", name: "alice" },
    { id: "2", name: null }
  ],
  stats: { scanned_rows: "5", matched_rows: "5", groups: "0", returned_rows: "2", raw_bytes: "64", elapsed_us: "900" },
  page: { offset: "0", limit: "100", returned_rows: "2", total_rows: "5", has_more: true }
}

/** The syntax error the stub answers for SQL containing JOIN. */
const QuerySyntaxErrorBody = {
  code: -32010,
  message: "unexpected JOIN",
  data: { kind: "QUERY_SYNTAX", retryable: false, line: 1, column: 19, limit: null }
}

/** Ceiling of one bin run; a run past it is killed (and awaited) and fails the test. */
const RunTimeoutMs = 60_000

/**
 * Run a bin with sandboxed stores (async: the stub server lives in THIS process,
 * so a synchronous spawn would starve it). Empty WIRE_QL_* seeds count as unset.
 * A run that outlives {@link RunTimeoutMs} is SIGKILLed and its exit awaited
 * before the promise rejects, so a hung bin never outlives the test; the timer is
 * cleared when the child closes.
 */
function run(bin, args, input = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
        env: { ...process.env, XDG_CONFIG_HOME: Path.join(Sandbox, "config"), XDG_STATE_HOME: Path.join(Sandbox, "state"), WIRE_QL_URL: "", WIRE_QL_PROFILE: "" }
      }),
      stdout = [],
      stderr = []
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, RunTimeoutMs)
    child.stdout.on("data", chunk => stdout.push(chunk))
    child.stderr.on("data", chunk => stderr.push(chunk))
    child.once("error", error => {
      clearTimeout(timer)
      reject(error)
    })
    child.once("close", status => {
      clearTimeout(timer)
      const output = { status, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }
      if (timedOut) reject(new Error(`${Path.basename(bin)} ${args.join(" ")} did not exit within ${RunTimeoutMs} ms: ${output.stderr}`))
      else resolve(output)
    })
    child.stdin.end(input)
  })
}

/** A port from the bind registry (never a literal). */
async function registryPort() {
  const port = await BindConfigProvider.findAvailable(BindConfigProvider.DefaultBiosHttp)
  await BindConfigProvider.clearPortLocks()
  return port
}

describe("wql bundle", () => {
  let server
  let endpoint
  const requests = []

  before(async () => {
    const port = await registryPort()
    server = Http.createServer((request, response) => {
      let body = ""
      request.on("data", chunk => (body += chunk))
      request.on("end", () => {
        const { id, params } = JSON.parse(body)
        requests.push(params)
        response.writeHead(200, { "Content-Type": "application/json" })
        response.end(
          JSON.stringify(
            params.query.includes("JOIN")
              ? { jsonrpc: JsonRPCProtocol.Version, id, error: QuerySyntaxErrorBody }
              : { jsonrpc: JsonRPCProtocol.Version, id, result: Result }
          )
        )
      })
    })
    await new Promise((resolve, reject) => {
      server.once("error", reject)
      server.listen(port, Localhost, resolve)
    })
    endpoint = toURL(port)
  })

  after(() =>
    new Promise(resolve => {
      server.close(resolve)
      server.closeAllConnections()
    })
  )

  it("resolves the package entry to the bundle, which exports main without running it or patching the process", async () => {
    const manifest = JSON.parse(Fs.readFileSync(Path.join(PackagePath, "package.json"), "utf8")),
      prepareStackTrace = Error.prepareStackTrace,
      entry = await import(Path.resolve(PackagePath, manifest.exports["."].import))
    Assert.equal(Error.prepareStackTrace, prepareStackTrace, "importing the bundle must not install source-map-support")
    Assert.equal(manifest.main, undefined)
    Assert.equal(Path.resolve(PackagePath, manifest.exports["."].import), Path.join(BundlePath, "wql.mjs"))
    Assert.ok(Fs.existsSync(Path.resolve(PackagePath, manifest.exports["."].types)))
    Assert.equal(typeof entry.main, "function")
    Assert.equal(process.exitCode, undefined)
    Assert.ok(!manifest.files.includes("lib"), "only declarations of lib/ ship")
  })

  it("emits an executable entry and split chunks", () => {
    Assert.ok(Fs.statSync(Path.join(BundlePath, "wql.mjs")).mode & 0o100)
    Assert.ok(Fs.readdirSync(Path.join(BundlePath, "chunks")).some(file => file.endsWith(".mjs")))
  })

  it("prints --help, --version and `tui --help`", async () => {
    const help = await run(WqlBin, ["--help"]),
      version = await run(WqlBin, ["--version"]),
      tuiHelp = await run(WqlBin, ["tui", "--help"]),
      tuiBinHelp = await run(TuiBin, ["--help"])
    Assert.equal(help.status, 0)
    Assert.match(help.stdout, /wql tui \[query\]/)
    Assert.match(help.stdout, /--page-size/)
    Assert.equal(version.status, 0)
    Assert.equal(version.stdout.trim(), JSON.parse(Fs.readFileSync(Path.join(PackagePath, "package.json"), "utf8")).version)
    Assert.equal(tuiHelp.status, 0)
    Assert.match(tuiHelp.stdout, /open the interactive terminal workbench/)
    Assert.match(tuiBinHelp.stdout, /wql tui \[query\]/)
  })

  it("parses `wql <sql>` (limit 100) and `wql --all <sql>` (no limit)", async () => {
    requests.length = 0
    Assert.equal((await run(WqlBin, ["-u", endpoint, "SELECT * FROM sample.positions"])).status, 0)
    Assert.equal((await run(WqlBin, ["-u", endpoint, "--all", "SELECT * FROM sample.positions"])).status, 0)
    Assert.deepEqual(requests, [
      { query: "SELECT * FROM sample.positions", limit: 100, offset: 0 },
      { query: "SELECT * FROM sample.positions", offset: 0 }
    ])
  })

  for (const format of Object.values(OutputFormat)) {
    it(`renders --format ${format} exactly like ResultRenderer (golden)`, async () => {
      const execution = { status: "success", requestId: "r", query: "q", wallTimeMs: 0, attempts: 1, result: Result },
        view = ResultView.create(Result),
        expected = ResultRenderer.render(format, { execution, view, range: view.fullRange() }, { color: false }),
        result = await run(WqlBin, ["-u", endpoint, "--format", format, "--no-color", "SELECT * FROM sample.positions"])
      Assert.equal(result.status, 0, result.stderr)
      const footer = [OutputFormat.table, OutputFormat.markdown].includes(format) ? "\npage 1/1 · rows 1–2 of 5 · block 42\n" : ""
      Assert.equal(result.stdout, `${expected}${footer}`)
      Assert.match(result.stderr, /more rows: --page 2/)
    })
  }

  it("maps outcomes to exit codes: syntax 10 (with caret), transport 3, usage 2", async () => {
    const syntax = await run(WqlBin, ["-u", endpoint, "SELECT * FROM a.b JOIN c.d"]),
      transport = await run(WqlBin, ["-u", toURL(await registryPort()), "SELECT * FROM a.b"]),
      conflict = await run(WqlBin, ["-u", endpoint, "--all", "--page", "2", "SELECT * FROM a.b"]),
      raw = await run(WqlBin, ["-u", endpoint, "--format", "raw", "--sort", "id", "SELECT * FROM a.b"])
    Assert.equal(syntax.status, 10)
    Assert.match(syntax.stderr, /error: QUERY_SYNTAX: unexpected JOIN\n {2}SELECT \* FROM a\.b JOIN c\.d\n {20}\^{4}/)
    Assert.equal(transport.status, 3)
    Assert.equal(conflict.status, 2)
    Assert.match(conflict.stderr, /mutually exclusive/)
    Assert.equal(raw.status, 2)
    Assert.equal((await run(WqlBin, ["-u", endpoint, "--page", "2", "--format", "raw", "SELECT * FROM a.b"])).status, 0)
  })

  it("reads the query from stdin", async () => {
    requests.length = 0
    Assert.equal((await run(WqlBin, ["-u", endpoint], "SELECT * FROM piped.t")).status, 0)
    Assert.equal(requests[0].query, "SELECT * FROM piped.t")
  })

  it("reads --query-file / -F and writes --output-file / -o", async () => {
    const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), "wql-bundle-files-")),
      queryFile = Path.join(directory, "q.sql"),
      outputFile = Path.join(directory, "out.csv"),
      shortOutputFile = Path.join(directory, "short.json")
    try {
      Fs.writeFileSync(queryFile, "SELECT * FROM from.file\n")
      requests.length = 0
      Assert.equal((await run(WqlBin, ["-u", endpoint, "--query-file", queryFile, "--output-file", outputFile])).status, 0)
      Assert.equal((await run(WqlBin, ["-u", endpoint, "-F", queryFile, "-o", shortOutputFile])).status, 0)
      Assert.deepEqual(requests.map(params => params.query), ["SELECT * FROM from.file", "SELECT * FROM from.file"])
      Assert.match(Fs.readFileSync(outputFile, "utf8"), /^[^\n]*,/)
      Assert.ok(Array.isArray(JSON.parse(Fs.readFileSync(shortOutputFile, "utf8"))))
    } finally {
      Fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("logs with REAL per-file categories from inside the bundle", async () => {
    const result = await run(WqlBin, ["-u", endpoint, "--log-level", "debug", "--format", "json", "SELECT * FROM a.b"])
    Assert.equal(result.status, 0)
    Assert.match(result.stderr, /\[cjs:client:QueryEngineClient\] \(debug\)/)
    Assert.match(result.stderr, /\[cli:commands:QueryCommand\] \(debug\)/)
  })

  it("gives every logging module of the bundle a distinct category", () => {
    const declarations = Fs.readdirSync(BundlePath, { recursive: true })
        .filter(file => file.endsWith(".mjs"))
        .flatMap(file => [...Fs.readFileSync(Path.join(BundlePath, file), "utf8").matchAll(/(?:const|var|let) __filename\d* = "(packages\/[^"]+)"/g)].map(match => match[1])),
      logging = [...new Set(declarations)].filter(file => {
        const source = Path.join(RepositoryRoot, file)
        return Fs.existsSync(source) && Fs.readFileSync(source, "utf8").includes("getLogger(__filename)")
      }),
      categories = logging.map(filenameCategoryInterpolator)
    Assert.ok(logging.length >= 5, `logging modules found: ${logging.join(", ")}`)
    Assert.equal(new Set(categories).size, categories.length, categories.join(", "))
  })

  it("the bin asserts when the bundle is missing", async () => {
    const copy = Path.join(Sandbox, "no-bundle", "bin")
    Fs.mkdirSync(copy, { recursive: true })
    Fs.copyFileSync(WqlBin, Path.join(copy, "wql"))
    const result = await run(Path.join(copy, "wql"), ["--help"])
    Assert.notEqual(result.status, 0)
    Assert.match(result.stderr, /Main file not found/)
  })
})
