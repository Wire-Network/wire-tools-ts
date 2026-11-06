import Fs from "node:fs"
import Path from "node:path"
import Ajv2020 from "ajv/dist/2020"
import { BindRegistrationDocument, BindRegistrationSchemaCodec } from "@wireio/cluster-tool-shared"

/** The wire-tools-ts repository root (tests/config → package → packages → repository). */
const RepoRoot = Path.resolve(__dirname, "..", "..", "..", "..")
/** The bind-registry protocol documentation directory. */
const DocsPath = Path.join(RepoRoot, "docs", "bind-registry")
/** The committed, generated JSON Schema (generator drift is gated by WireOpregBootstrapDocs.test.ts). */
const SchemaFile = Path.join(DocsPath, "bind-registration.schema.json")
/** The committed example registration. */
const ExampleFile = Path.join(DocsPath, "bind-registration.example.json")

/** The committed JSON Schema text. */
function schemaText(): string {
  return Fs.readFileSync(SchemaFile, "utf8")
}

/** The committed example text. */
function exampleText(): string {
  return Fs.readFileSync(ExampleFile, "utf8")
}

describe("docs/bind-registry/bind-registration.schema.json", () => {
  it("is exactly the codec's generated JSON Schema", () => {
    expect(JSON.parse(schemaText())).toEqual(
      BindRegistrationSchemaCodec.toJSONSchema()
    )
  })

  it("carries a title and a description for the document and each member", () => {
    const schema = JSON.parse(schemaText())
    expect(schema.title).toBe(BindRegistrationDocument.Title)
    expect(schema.description).toBe(BindRegistrationDocument.Description)
    expect(schema.properties.executable.description).toEqual(expect.any(String))
    expect(schema.properties.ports.description).toEqual(expect.any(String))
  })
})

describe("docs/bind-registry/bind-registration.example.json", () => {
  it("decodes through BindRegistrationSchemaCodec", () => {
    const example = BindRegistrationSchemaCodec.deserialize(exampleText())
    expect(example.executable).not.toBe("")
    expect(example.ports.length).toBeGreaterThan(0)
  })

  it("validates against the committed JSON Schema (ajv, draft 2020-12, strict)", () => {
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(
      JSON.parse(schemaText())
    )
    const valid = validate(JSON.parse(exampleText()))
    expect(validate.errors ?? []).toEqual([])
    expect(valid).toBe(true)
  })
})
