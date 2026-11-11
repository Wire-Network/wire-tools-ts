import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { SolanaFixedPriceOracleTool as Oracle } from "@wireio/cluster-tool/tools/solana"
import { Report } from "@wireio/cluster-tool/report"
import { fixtureConfig } from "../../config/clusterConfigFixture.js"
import { fixtureContext } from "../../config/clusterBuildContextFixture.js"

describe("SolanaFixedPriceOracleTool", () => {
  let directory: string
  let originalPath: string
  beforeEach(() => {
    directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), "fixed-oracle-"))
    originalPath = process.env.PATH
  })
  afterEach(() => {
    if (originalPath == null) delete process.env.PATH
    else process.env.PATH = originalPath
    Fs.rmSync(directory, { recursive: true, force: true })
  })

  function context() {
    return fixtureContext({
      dataPath: directory,
      enableSolanaFixedPriceOracle: true
    })
  }

  /** A real child process verifies the compiler boundary without requiring an SBF SDK in Jest. */
  function compiler(body: string): void {
    const binary = Path.join(directory, Oracle.BuildExecutable)
    Fs.writeFileSync(binary, `#!${process.execPath}\n${body}\n`, {
      mode: 0o755
    })
    process.env.PATH = [directory, originalPath]
      .filter(Boolean)
      .join(Path.delimiter)
  }

  it("ships the Cargo sources and lockfile in the installed package", () => {
    const source = Oracle.sourceDirectory()
    for (const file of ["Cargo.toml", "Cargo.lock", "src/lib.rs"])
      expect(Fs.existsSync(Path.join(source, file))).toBe(true)
    const manifest = JSON.parse(
      Fs.readFileSync(Path.join(source, "../../package.json"), "utf8")
    )
    expect(manifest.files).toEqual(
      expect.arrayContaining([
        "resources/fixed-price-oracle/Cargo.toml",
        "resources/fixed-price-oracle/Cargo.lock",
        "resources/fixed-price-oracle/src"
      ])
    )
  })

  it("keeps the fixture off by default and rejects external installation", () => {
    const config = fixtureConfig({ dataPath: directory })
    expect(Oracle.accountArgs(config)).toEqual([])
    expect(() => Oracle.program(config)).toThrow(/opted-in local/)
    expect(() =>
      Oracle.assertLocalFixture({
        ...config,
        enableSolanaFixedPriceOracle: true,
        externalOutposts: {} as NonNullable<typeof config.externalOutposts>
      })
    ).toThrow(/opted-in local/)
  })

  it("preloads the pinned feed under the oracle owner and shares the paths with validator argv", async () => {
    const ctx = context()
    await Oracle.runFeed(ctx, null, new AbortController().signal)
    const args = Oracle.accountArgs(ctx.config)
    expect(args.slice(0, 2)).toEqual(["--account", Oracle.FeedId.toBase58()])
    const feed = JSON.parse(Fs.readFileSync(args[2], "utf8"))
    expect(feed.pubkey).toBe(Oracle.FeedId.toBase58())
    expect(feed.account).toMatchObject({
      owner: Oracle.ProgramId.toBase58(),
      executable: false,
      data: ["AA==", "base64"]
    })
    expect(Oracle.program(ctx.config)).toEqual({
      name: "fixed-price-oracle",
      programId: Oracle.ProgramId.toBase58(),
      soFile: Path.join(
        directory,
        Oracle.ArtifactSubdirectory,
        Oracle.ProgramFilename
      )
    })
  })

  it("builds into cluster-local directories with locked dependencies and no development feature", async () => {
    compiler(`
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), output = args[args.indexOf('--sbf-out-dir') + 1];
fs.writeFileSync(path.join(output, '${Oracle.ProgramFilename}'), 'test artifact');
fs.writeFileSync(path.join(output, 'compiler-input.json'), JSON.stringify({args, target: process.env.CARGO_TARGET_DIR}));
`)
    const ctx = context()
    await Oracle.runBuild(ctx, null, new AbortController().signal)
    const input = JSON.parse(
      Fs.readFileSync(
        Path.join(Oracle.artifactDirectory(ctx.config), "compiler-input.json"),
        "utf8"
      )
    )
    expect(input.args).toEqual([
      "--manifest-path",
      Path.join(Oracle.sourceDirectory(), "Cargo.toml"),
      "--sbf-out-dir",
      Oracle.artifactDirectory(ctx.config),
      "--arch",
      "v3",
      "--",
      "--locked"
    ])
    expect(input.target).toBe(
      Path.join(Oracle.artifactDirectory(ctx.config), "target")
    )
  })

  it("fails on compiler errors and on a successful process that emitted no program", async () => {
    compiler("process.stderr.write('compiler failure'); process.exit(7)")
    await expect(
      Oracle.runBuild(context(), null, new AbortController().signal)
    ).rejects.toThrow(/oracle failed/)
    compiler("process.exit(0)")
    await expect(
      Oracle.runBuild(context(), null, new AbortController().signal)
    ).rejects.toThrow(/did not produce/)
  })

  it("plans the compiler and feed preparation as separate Report Steps and respects cancellation", async () => {
    const build = Oracle.planBuild(Report.Actor.SolanaOutpost)
    const feed = Oracle.planFeed(Report.Actor.SolanaOutpost)
    expect(build.runner).toBe(Oracle.runBuild)
    expect(feed.runner).toBe(Oracle.runFeed)
    expect(build.name).not.toBe(feed.name)
    const controller = new AbortController()
    controller.abort()
    await expect(
      Oracle.runBuild(context(), null, controller.signal)
    ).rejects.toThrow()
    await expect(
      Oracle.runFeed(context(), null, controller.signal)
    ).rejects.toThrow()
    expect(Fs.existsSync(Oracle.artifactDirectory(context().config))).toBe(
      false
    )
  })
})
