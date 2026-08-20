import { execFileSync } from "node:child_process"
import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"

/**
 * The repo-level scanner script — the release workflow's blocking pre-upload
 * gate. It lives in `wire-tools-ts/scripts/` (CLI scripts are `.mjs` + zx, never
 * a package `bin/`); this suite hosts its coverage because `cluster-tool` owns
 * the archives the gate guards and `scripts/` has no jest project of its own.
 */
const ScannerScript = Path.resolve(__dirname, "..", "..", "..", "..", "scripts", "scan-key-material.mjs")

/** Exit code the scanner uses for "key material found". */
const HitExitCode = 1
/** Exit code the scanner uses for a usage error. */
const UsageExitCode = 2

/** What `execFileSync` attaches to the error it throws on a non-zero exit. */
interface ExecFailure {
  status: number
  stdout: string
}

/** One scanner invocation: its exit code and whatever it wrote to stdout. */
interface ScannerRun {
  status: number
  output: string
}

/** The scanner's result for `args`, without throwing on a non-zero exit. */
function runScanner(...args: string[]): ScannerRun {
  try {
    const output = execFileSync(process.execPath, [ScannerScript, ...args], {
      encoding: "utf8"
    })
    return { status: 0, output }
  } catch (error) {
    // execFileSync throws on any non-zero exit; the code + stdout ride the error.
    const failure = error as ExecFailure
    return { status: failure.status, output: `${failure.stdout ?? ""}` }
  }
}

describe("scripts/scan-key-material.mjs", () => {
  let dir: string

  beforeEach(() => {
    dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "scan-key-material-"))
  })

  afterEach(() => {
    Fs.rmSync(dir, { recursive: true, force: true })
  })

  it("passes a refs-only tree — the shape an SSM cluster's archive ships", () => {
    Fs.writeFileSync(
      Path.join(dir, "cluster-keys.json"),
      JSON.stringify({
        operators: [
          {
            label: "batchop.a",
            account: "wireno.x3f9k",
            wire: {
              publicKey: "PUB_K1_6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV",
              awsSecretId: "/wire/test/batchop.a/K1"
            }
          }
        ]
      })
    )
    const { status, output } = runScanner(dir)
    expect(status).toBe(0)
    expect(output).toContain("clean")
  })

  it("REFUSES a tree carrying a WIRE private key, naming the file and the pattern", () => {
    const leaked = Path.join(dir, "leak.json")
    Fs.writeFileSync(
      leaked,
      JSON.stringify({
        privateKey: "PVT_K1_2bfGi9rYsXQSXXTvJbDAPhHLQUojjaNLomdm3cEJ1XTdfThJ4i"
      })
    )
    const { status, output } = runScanner(dir)
    expect(status).toBe(HitExitCode)
    expect(output).toContain(leaked)
    expect(output).toMatch(/private key/i)
  })

  it("finds material nested arbitrarily deep, not just at the root", () => {
    const nested = Path.join(dir, "data", "nodes", "node_00")
    Fs.mkdirSync(nested, { recursive: true })
    Fs.writeFileSync(
      Path.join(nested, "config.ini"),
      "signature-provider=PUB_K1_x=KEY:PVT_K1_2bfGi9rYsXQSXXTvJbDAPhHLQUojjaNLomdm3cEJ1XTdfThJ4i\n"
    )
    expect(runScanner(dir).status).toBe(HitExitCode)
  })

  it("skips binary blobs instead of choking on them", () => {
    // Block logs / ledgers / .so files cannot carry a text-encoded key, and
    // reading them as utf8 yields mojibake — never a real match.
    Fs.writeFileSync(Path.join(dir, "blocks.log"), Buffer.from([0, 1, 2, 3, 0, 255, 254, 0]))
    Fs.writeFileSync(Path.join(dir, "notes.txt"), "nothing secret here\n")
    expect(runScanner(dir).status).toBe(0)
  })

  it("exits with a usage error when given no target", () => {
    expect(runScanner().status).toBe(UsageExitCode)
  })
})
