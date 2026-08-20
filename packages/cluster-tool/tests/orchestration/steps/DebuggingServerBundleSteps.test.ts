import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { Steps } from "@wireio/cluster-tool/orchestration/steps"
import { DaemonConfig } from "@wireio/cluster-tool/config"

const bundleSteps = Steps.debuggingServerBundle

describe("DebuggingServerBundleSteps", () => {
  let dir: string
  beforeEach(() => {
    dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "dbgbundle-"))
  })
  afterEach(() => {
    Fs.rmSync(dir, { recursive: true, force: true })
  })

  /** A bundle directory holding every required file. */
  function completeBundle(): string {
    const source = Path.join(dir, "bundle")
    Fs.mkdirSync(source, { recursive: true })
    bundleSteps.BundleFilenames.forEach(filename => Fs.writeFileSync(Path.join(source, filename), `stub:${filename}`))
    return source
  }

  it("resolves the bundle directory through the package, not a relative depth", () => {
    // pnpm symlinks the workspace, so a hand-counted `../../..` breaks the
    // moment the layout shifts.
    expect(bundleSteps.bundleDirectory()).toContain(Path.join("dist", "bundle"))
  })

  it("ships the sourcemap alongside the bundle", () => {
    // `--enable-source-maps` needs it, and the scanner now proves the map is
    // clean of key material.
    expect(bundleSteps.BundleFilenames).toContain(`${DaemonConfig.DebuggingServerBundleFilename}.map`)
  })

  it("copies every bundle file into the target directory", () => {
    const target = Path.join(dir, "data", DaemonConfig.DebuggingServerSubpath)
    bundleSteps.copyBundle(completeBundle(), target)
    bundleSteps.BundleFilenames.forEach(filename => expect(Fs.existsSync(Path.join(target, filename))).toBe(true))
  })

  it("FAILS LOUDLY when the bundle is absent", () => {
    // CI installs with a plain `pnpm install` so `prepare` builds it today —
    // but that is implicit, and one `--ignore-scripts` would otherwise ship a
    // cluster whose debugging server is silently missing.
    expect(() => bundleSteps.assertBundlePresent(Path.join(dir, "nonexistent"))).toThrow(/bundle missing/)
  })

  it("FAILS LOUDLY when only the sourcemap is missing", () => {
    const source = completeBundle()
    Fs.rmSync(Path.join(source, `${DaemonConfig.DebuggingServerBundleFilename}.map`))
    expect(() => bundleSteps.assertBundlePresent(source)).toThrow(/bundle missing/)
  })

  it("honours an already-aborted signal", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      bundleSteps.runCopy(
        { config: { dataPath: dir } } as Parameters<typeof bundleSteps.runCopy>[0],
        { kind: "DebuggingServerBundleSteps.CopyInput" },
        controller.signal
      )
    ).rejects.toThrow()
  })
})
