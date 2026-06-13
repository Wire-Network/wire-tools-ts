import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { Clio } from "@wireio/test-cluster-tool"

/**
 * Pins the FULL negative-push surface end to end: a clio binary that
 * prints a chain-side rejection (assert text) to STDOUT and exits
 * non-zero must produce a `pushActionAndWait` rejection whose `message`
 * contains that assert text — the exact contract the flows' negative
 * tests (`expect(...).rejects.toThrow(/some assert/)`) depend on.
 */
describe("Clio push rejection surface", () => {
  const ASSERT_TEXT =
    "assertion failure with message: matchreserve: matcher has no authex link for the reserve's chain"
  let fakeClioPath: string
  let tmpDir: string

  beforeAll(() => {
    tmpDir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "fake-clio-"))
    fakeClioPath = Path.join(tmpDir, "clio")
    // Emits a rejection trace to stdout (like `clio -j` does for an
    // asserted push) and exits 1. Double-quoted in sh because the assert
    // text contains an apostrophe; the JSON's quotes are escaped for sh.
    const trace = `{\\"processed\\":{\\"except\\":{\\"message\\":\\"${ASSERT_TEXT}\\"}}}`
    Fs.writeFileSync(
      fakeClioPath,
      `#!/bin/sh\necho "${trace}"\nexit 1\n`,
      { mode: 0o755 }
    )
  })

  afterAll(() => {
    Fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("rejects with the on-chain assert text folded into the message", async () => {
    const clio = new Clio({
      clusterPath: tmpDir,
      binary: fakeClioPath,
      url: "http://127.0.0.1:1"
    })

    await expect(
      clio.pushActionAndWait(
        "sysio.reserv",
        "matchreserve",
        { matcher: "wrongmatchr" },
        "wrongmatchr@active",
        1_000
      )
    ).rejects.toThrow(/matcher has no authex link/)
  }, 30_000)
})
