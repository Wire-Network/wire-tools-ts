import { spawnSync } from "node:child_process"
import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import Ajv2020 from "ajv/dist/2020"
import {
  WireOpregBootstrapSchemaCodec,
  findKeyMaterial
} from "@wireio/cluster-tool-shared"

/** The wire-tools-ts repository root (tests/cluster → package → packages → repository). */
const RepoRoot = Path.resolve(__dirname, "..", "..", "..", "..")
/** The published documentation directory of the file. */
const DocsPath = Path.join(RepoRoot, "docs", "outpost")
/** The committed, generated JSON Schema. */
const SchemaFile = Path.join(DocsPath, "wire-opreg-bootstrap.schema.json")
/** The committed example document. */
const ExampleFile = Path.join(DocsPath, "wire-opreg-bootstrap.example.json")
/** The generator of {@link SchemaFile} — it reads the BUILT package (root `pnpm test` builds first). */
const GeneratorScript = Path.join(RepoRoot, "scripts", "generate-json-schemas.mjs")

/** The generator's documented exit codes. */
enum GeneratorExit {
  success = 0,
  drift = 1,
  usage = 2
}

/**
 * Run the generator script.
 *
 * @param args - The script's arguments.
 * @returns Its exit status.
 */
function runGenerator(...args: string[]): number {
  return spawnSync(process.execPath, [GeneratorScript, ...args], {
    cwd: RepoRoot,
    stdio: "pipe"
  }).status
}

/**
 * Run `body` with a fresh temporary directory, removed afterwards.
 *
 * @param body - Receives the directory.
 */
function withTempDirectory(body: (directory: string) => void): void {
  const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), "wire-opreg-bootstrap-docs-"))
  try {
    body(directory)
  } finally {
    Fs.rmSync(directory, { recursive: true, force: true })
  }
}

/** The committed JSON Schema text. */
function schemaText(): string {
  return Fs.readFileSync(SchemaFile, "utf8")
}

/** The committed example text. */
function exampleText(): string {
  return Fs.readFileSync(ExampleFile, "utf8")
}

describe("docs/outpost/wire-opreg-bootstrap.schema.json", () => {
  it("is exactly the codec's generated JSON Schema", () => {
    expect(JSON.parse(schemaText())).toEqual(WireOpregBootstrapSchemaCodec.toJSONSchema())
  })

  it("passes the generator script's --check", () => {
    expect(runGenerator("--check")).toBe(GeneratorExit.success)
  })

  it("is byte-identical to what the generator script writes", () => {
    withTempDirectory(outputPath => {
      expect(runGenerator("--output-path", outputPath)).toBe(GeneratorExit.success)
      expect(
        Fs.readFileSync(Path.join(outputPath, Path.basename(SchemaFile)), "utf8")
      ).toBe(schemaText())
    })
  })

  it("makes the generator's --check exit 1 on a stale document", () => {
    withTempDirectory(outputPath => {
      Fs.writeFileSync(Path.join(outputPath, Path.basename(SchemaFile)), "{}\n")
      expect(runGenerator("--check", "--output-path", outputPath)).toBe(GeneratorExit.drift)
    })
  })

  it("makes the generator exit 2 when the package is not built", () => {
    withTempDirectory(sharedPath => {
      expect(runGenerator("--check", "--shared-path", sharedPath)).toBe(GeneratorExit.usage)
    })
  })
})

describe("docs/outpost/wire-opreg-bootstrap.example.json", () => {
  it("decodes through WireOpregBootstrapSchemaCodec", () => {
    const example = WireOpregBootstrapSchemaCodec.deserialize(exampleText())
    expect(example.operators.length).toBeGreaterThan(0)
    expect(example.batchOperatorGroups.groups.length).toBeGreaterThan(0)
  })

  it("validates against the committed JSON Schema (ajv, draft 2020-12, strict)", () => {
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(
      JSON.parse(schemaText())
    )
    const valid = validate(JSON.parse(exampleText()))
    expect(validate.errors ?? []).toEqual([])
    expect(valid).toBe(true)
  })

  it("carries no key material", () => {
    expect(findKeyMaterial(exampleText()).map(pattern => pattern.name)).toEqual([])
  })
})
