import { spawnSync } from "node:child_process"
import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"

const RepoRoot = Path.resolve(__dirname, "../../../..")
let fixturePath: string, runnerScript: string
const DisabledFlows = [
  "flow-reserve-lifecycle",
  "flow-swap-from-wire",
  "flow-swap-to-wire",
  "flow-swap-non-native-tokens",
  "flow-swap-private-reserves",
  "flow-swap-variance-revert",
  "flow-swap-with-underwriting",
  "flow-underwriter-slashing"
] as const

/** Run selection only: an empty build path prevents any live flow launch. */
function selectFlow(pattern: string, input = "") {
  const result = spawnSync(
    process.execPath,
    [runnerScript, ...(pattern ? [pattern] : []), "--wire-build-path="],
    { encoding: "utf8", input, timeout: 10_000 }
  )
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(1)
  const output = result.stdout + result.stderr
  expect(output).not.toContain("Running @wireio/")
  return output
}

describe("flow runner discovery", () => {
  beforeAll(() => {
    fixturePath = Fs.mkdtempSync(Path.join(Os.tmpdir(), "flow-discovery-"))
    Fs.mkdirSync(Path.join(fixturePath, "scripts"))
    runnerScript = Path.join(fixturePath, "scripts/run-flow.mjs")
    Fs.copyFileSync(Path.join(RepoRoot, "scripts/run-flow.mjs"), runnerScript)
    Fs.symlinkSync(
      Path.join(RepoRoot, "node_modules"),
      Path.join(fixturePath, "node_modules")
    )
    for (const name of [
      ...DisabledFlows,
      "flow-operator-collateral-deposit",
      "flow-operator-fixture"
    ]) {
      const directory = Path.join(fixturePath, "packages", name)
      Fs.mkdirSync(directory, { recursive: true })
      const script = name.startsWith("flow-operator-")
        ? "test"
        : "test:disabled"
      Fs.writeFileSync(
        Path.join(directory, "package.json"),
        JSON.stringify({
          name,
          scripts: { [script]: "node lib/index.js" }
        })
      )
    }
  })

  afterAll(() => Fs.rmSync(fixturePath, { recursive: true, force: true }))

  it("re-enables a package by restoring its test script alone", () => {
    const name = DisabledFlows[0]
    const packageFile = Path.join(fixturePath, "packages", name, "package.json")
    const original = Fs.readFileSync(packageFile, "utf8")
    try {
      Fs.writeFileSync(
        packageFile,
        original.replace('"test:disabled"', '"test"')
      )
      expect(selectFlow(name)).toContain("Error: --wire-build-path is required")
    } finally {
      Fs.writeFileSync(packageFile, original)
    }
  })

  it.each(DisabledFlows)("refuses disabled full and short names: %s", name => {
    for (const pattern of [name, name.replace(/^flow-/, "")]) {
      const output = selectFlow(pattern)
      expect(output).toContain(
        `Skipping ${name}: disabled (no test script; see README.md).`
      )
      expect(output).toContain(`No flow matches "${pattern}".`)
      const available = output.split("Available: ")[1]
      expect(available).toContain("flow-operator-collateral-deposit")
      for (const disabled of DisabledFlows)
        expect(available).not.toContain(disabled)
    }
  })

  it("excludes disabled flows from regex matching", () => {
    expect(selectFlow("swap|reserve|underwriter-slashing")).toContain(
      'No flow matches "swap|reserve|underwriter-slashing".'
    )
  })

  it.each(["", "flow-.*"])(
    "excludes disabled flows from the picker: %s",
    pattern => {
      const output = selectFlow(pattern, "\n")
      const picker = output.split("Available flows:")[1]
      expect(picker).toContain("flow-operator-collateral-deposit")
      for (const disabled of DisabledFlows)
        expect(picker).not.toContain(disabled)
    }
  )

  it.each([
    "flow-operator-collateral-deposit",
    "operator-collateral-deposit",
    "^flow-operator-collateral-deposit$"
  ])("still resolves an enabled flow: %s", pattern => {
    expect(selectFlow(pattern)).toContain(
      "Error: --wire-build-path is required"
    )
  })
})
