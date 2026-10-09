import Crypto from "node:crypto"
import Fs from "node:fs"
import Path from "node:path"

import Ajv from "ajv-draft-04"
import type { z } from "zod"

import {
  QueryAbiReferenceSchema,
  QueryColumnSchema,
  QueryEngineErrorSchema,
  QueryErrorDataSchema,
  QueryPageSchema,
  QueryRequestCodec,
  QueryRequestParamsSchema,
  QueryRequestSchema,
  QueryResponseEnvelopeCodec,
  QueryResponseErrorEnvelopeSchema,
  QueryResponseSuccessEnvelopeSchema,
  QueryResultSchema,
  QuerySourceSchema,
  QueryStateSchema,
  QueryStatsSchema
} from "@wireio/ql-shared"

import { EngineFixturesPath, readEngineExample } from "../common/resultFixtures.js"

/** A JSON Schema object node (the subset this test reads). */
interface JsonSchemaNode {
  required?: string[]
  additionalProperties?: boolean
  properties?: Record<string, JsonSchemaNode>
  definitions?: Record<string, JsonSchemaNode>
  oneOf?: JsonSchemaNode[]
  items?: JsonSchemaNode
  minItems?: number
}

/** The recorded drift record. */
interface SchemaSourceRecord {
  requestSchemaSha256: string
  responseSchemaSha256: string
  examples: Record<string, string>
}

const schemaPath = Path.join(EngineFixturesPath, "schema"),
  examplesPath = Path.join(EngineFixturesPath, "examples"),
  readJson = <T>(file: string): T => JSON.parse(Fs.readFileSync(file, "utf8")),
  requestSchema = readJson<JsonSchemaNode>(Path.join(schemaPath, "query-request.schema.json")),
  responseSchema = readJson<JsonSchemaNode>(Path.join(schemaPath, "query-response.schema.json")),
  ajv = new Ajv({ strict: false }),
  validateRequest = ajv.compile(requestSchema),
  validateResponse = ajv.compile(responseSchema),
  definitions = responseSchema.definitions,
  examples = Fs.readdirSync(examplesPath).filter(name => name.endsWith(".json")).sort(),
  isRequestExample = (name: string) => name.startsWith("request")

/** Keys a zod object requires (a member that rejects `undefined`). */
function zodRequiredKeys(schema: z.ZodObject): string[] {
  return Object.entries(schema.shape)
    .filter(([, member]) => !(member as z.ZodType).safeParse(undefined).success)
    .map(([key]) => key)
    .sort()
}

describe("engine contract (committed wire-sysio query_engine_plugin schemas + examples)", () => {
  it("covers the paged examples", () => {
    expect(examples).toEqual(
      expect.arrayContaining(["error.json", "request.json", "request-paged.json", "response.json", "response-paged.json"])
    )
  })

  it.each(examples)("%s decodes with zod AND validates with ajv-draft-04", name => {
    const text = readEngineExample(name),
      parsed = JSON.parse(text)
    if (isRequestExample(name)) {
      expect(validateRequest(parsed)).toBe(true)
      expect(QueryRequestCodec.deserialize(text)).toEqual(parsed)
    } else {
      expect(validateResponse(parsed)).toBe(true)
      expect(QueryResponseEnvelopeCodec.deserialize(text)).toEqual(parsed)
    }
  })

  it.each([
    ["result", definitions.result, QueryResultSchema],
    ["state", definitions.state, QueryStateSchema],
    ["stats", definitions.stats, QueryStatsSchema],
    ["source", definitions.source, QuerySourceSchema],
    ["column", definitions.column, QueryColumnSchema],
    ["page", definitions.page, QueryPageSchema],
    ["state.abis[]", definitions.state.properties.abis.items, QueryAbiReferenceSchema],
    ["error", definitions.error, QueryEngineErrorSchema],
    ["error.data", definitions.error.properties.data, QueryErrorDataSchema],
    ["success envelope", responseSchema.oneOf[0], QueryResponseSuccessEnvelopeSchema],
    ["error envelope", responseSchema.oneOf[1], QueryResponseErrorEnvelopeSchema],
    ["request", requestSchema, QueryRequestSchema],
    ["request params", requestSchema.properties.params, QueryRequestParamsSchema]
  ] as const)("%s: zod required keys equal the JSON Schema required array, and both are closed", (_name, node, schema) => {
    expect(zodRequiredKeys(schema as unknown as z.ZodObject)).toEqual([...node.required].sort())
    expect(node.additionalProperties).toBe(false)
    expect(Object.keys((schema as unknown as z.ZodObject).shape).sort()).toEqual(Object.keys(node.properties).sort())
  })

  it("rejects an extra key in both zod and ajv", () => {
    const response = JSON.parse(readEngineExample("response.json"))
    response.result.page.extra = "1"
    expect(validateResponse(response)).toBe(false)
    expect(QueryResponseEnvelopeCodec.check(response)).toBe(false)
    const request = JSON.parse(readEngineExample("request.json"))
    request.params.owner = "sample"
    expect(validateRequest(request)).toBe(false)
    expect(QueryRequestCodec.check(request)).toBe(false)
  })

  it("requires at least one column in both", () => {
    const response = JSON.parse(readEngineExample("response.json"))
    response.result.columns = []
    response.result.rows = []
    expect(definitions.result.properties.columns.minItems).toBe(1)
    expect(validateResponse(response)).toBe(false)
    expect(QueryResponseEnvelopeCodec.check(response)).toBe(false)
  })

  it("SCHEMA_SOURCE.json hashes match the committed copies", () => {
    const record = readJson<SchemaSourceRecord>(
        Path.join(__dirname, "..", "..", "src", "protocol", "SCHEMA_SOURCE.json")
      ),
      sha256 = (file: string) => Crypto.createHash("sha256").update(Fs.readFileSync(file)).digest("hex")
    expect(record.requestSchemaSha256).toBe(sha256(Path.join(schemaPath, "query-request.schema.json")))
    expect(record.responseSchemaSha256).toBe(sha256(Path.join(schemaPath, "query-response.schema.json")))
    expect(record.examples).toEqual(
      Object.fromEntries(examples.map(name => [name, sha256(Path.join(examplesPath, name))]))
    )
  })
})
