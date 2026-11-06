import { OperatorType } from "@wireio/opp-typescript-models"
import { KeyType } from "@wireio/sdk-core"
import {
  AWSAccountName,
  ClusterFiles,
  SchemaCodec,
  WireOpregBootstrap,
  WireOpregBootstrapSchema,
  WireOpregBootstrapSchemaCodec,
  type WireOpregBootstrap as WireOpregBootstrapDocument,
  type WireOpregBootstrapOperator
} from "@wireio/cluster-tool-shared"
import { z } from "zod"

/** Cluster build label of the fixture document. */
const Label = "testnet-epoch60"
/** Producer account in the fixture roster. */
const ProducerAccount = "defproducera"
/** Batch-operator accounts in the fixture roster (generated `wireno.` names). */
const BatchAccounts = ["wireno.a1b2c", "wireno.d3e4f", "wireno.g5h1i"] as const

/** A fixture producer: K1 account key + BLS finality key. */
function producer(accountName: string): WireOpregBootstrapOperator {
  return {
    accountName,
    type: OperatorType.PRODUCER,
    keys: {
      wire: { type: KeyType.K1, publicKey: "PUB_K1_6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV" },
      wireFinalizer: {
        type: KeyType.BLS,
        publicKey: "PUB_BLS_Uf5R9wMXNAG6QxRN3VjwDsgHnVkdaHvQb4j0zcxLlYVyLYxRf1XmPfZU0dyLmA7Q",
        proofOfPossession: "SIG_BLS_k4aN0F6kaRcR6HH5Q0dWgGYZFaaYTbRk_x8KBx6oXqq6vB-GNW9F8yG"
      }
    }
  }
}

/** A fixture batch operator: K1 account key + EM and ED outpost keys. */
function batchOperator(accountName: string): WireOpregBootstrapOperator {
  return {
    accountName,
    type: OperatorType.BATCH,
    keys: {
      wire: { type: KeyType.K1, publicKey: "PUB_K1_5bbkxaLdB5bfVZW6DJY8M74vwT2m61PqwywNUa5azfkJ6ANZCp" },
      ethereum: {
        type: KeyType.EM,
        publicKey: "PUB_EM_02ba5734d8f7091719471e7f7ed6b9df170dc70cc661ca05e688601ad984f068b0",
        address: "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc"
      },
      solana: {
        type: KeyType.ED,
        publicKey: "PUB_ED_7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
        address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
      }
    }
  }
}

/** A valid document: one producer, three batch operators in three single-member groups. */
function fixtureDocument(): WireOpregBootstrapDocument {
  return {
    label: Label,
    awsAccount: AWSAccountName.test,
    epochDurationSec: 60,
    operators: [producer(ProducerAccount), ...BatchAccounts.map(batchOperator)],
    batchOperatorGroups: {
      activeGroupIndex: 0,
      groups: BatchAccounts.map(account => [account])
    }
  }
}

/** The wire (JSON) form of a document — what a consumer reads from disk. */
function wireForm(document: WireOpregBootstrapDocument) {
  return JSON.parse(WireOpregBootstrapSchemaCodec.serialize(document))
}

/** The `path: message` clauses of a rejected wire-form document. */
function issuesOf(json: unknown): string[] {
  return WireOpregBootstrapSchemaCodec.validate(json)
    .getLeftOrThrow()
    .issues.map(issue => `${issue.path.join(".")}: ${issue.message}`)
}

describe("WireOpregBootstrap", () => {
  it("is named by ClusterFiles.WireOpregBootstrapFilename", () => {
    expect(ClusterFiles.WireOpregBootstrapFilename).toBe("wire-opreg-bootstrap.json")
  })

  it("admits the PRODUCER, BATCH and UNDERWRITER operator types", () => {
    expect(WireOpregBootstrap.OperatorTypes).toEqual([
      OperatorType.PRODUCER,
      OperatorType.BATCH,
      OperatorType.UNDERWRITER
    ])
  })

  it("LabelPattern admits the workflow's label grammar only", () => {
    expect(WireOpregBootstrap.LabelPattern.test("testnet_epoch-60")).toBe(true)
    expect(WireOpregBootstrap.LabelPattern.test("Testnet")).toBe(false)
    expect(WireOpregBootstrap.LabelPattern.test("testnet.60")).toBe(false)
    expect(WireOpregBootstrap.LabelPattern.test("")).toBe(false)
  })

  it("publicKeyPattern anchors the Wire-canonical prefix of the curve", () => {
    expect(WireOpregBootstrap.publicKeyPattern(KeyType.EM).test("PUB_EM_02ab")).toBe(true)
    expect(WireOpregBootstrap.publicKeyPattern(KeyType.EM).test("PUB_K1_02ab")).toBe(false)
    expect(WireOpregBootstrap.publicKeyPattern(KeyType.K1).test("xPUB_K1_02ab")).toBe(false)
  })

  describe("codec", () => {
    it("writes operator types as their names and reads them back as the numeric enum", () => {
      const document = fixtureDocument(),
        json = wireForm(document)
      expect(json.operators.map((operator: WireOpregBootstrapOperator) => operator.type)).toEqual([
        "PRODUCER",
        "BATCH",
        "BATCH",
        "BATCH"
      ])
      expect(
        WireOpregBootstrapSchemaCodec.deserialize(WireOpregBootstrapSchemaCodec.serialize(document))
      ).toEqual(document)
    })

    it("pretty-prints with the shared indent width", () => {
      const document = fixtureDocument()
      expect(WireOpregBootstrapSchemaCodec.serialize(document)).toBe(
        JSON.stringify(wireForm(document), null, SchemaCodec.SerializeIndent)
      )
    })

    it("refuses to encode a document that breaks a consistency rule", () => {
      const document = fixtureDocument()
      document.batchOperatorGroups.activeGroupIndex = 3
      expect(() => WireOpregBootstrapSchemaCodec.serialize(document)).toThrow()
    })

    it("refuses to encode a non-admitted operator type", () => {
      const document = fixtureDocument()
      // A value the compiler already rejects — built through `unknown` to prove
      // the codec refuses it at run time too.
      document.operators[0] = {
        ...document.operators[0],
        type: OperatorType.CHALLENGER
      } as unknown as WireOpregBootstrapOperator
      expect(z.safeEncode(WireOpregBootstrapSchema, document).success).toBe(false)
    })
  })

  describe("field validation", () => {
    it("rejects a non-admitted operator type name", () => {
      const json = wireForm(fixtureDocument())
      json.operators[0].type = "CHALLENGER"
      expect(issuesOf(json).some(issue => issue.startsWith("operators.0.type"))).toBe(true)
    })

    it("pins each key slot to its curve", () => {
      const json = wireForm(fixtureDocument())
      json.operators[1].keys.ethereum.type = KeyType.K1
      expect(issuesOf(json).some(issue => issue.startsWith("operators.1.keys.ethereum.type"))).toBe(true)
    })

    it("rejects a public key whose prefix is not its slot's curve", () => {
      const json = wireForm(fixtureDocument())
      json.operators[1].keys.solana.publicKey = "PUB_K1_7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
      expect(issuesOf(json).some(issue => issue.startsWith("operators.1.keys.solana.publicKey"))).toBe(true)
    })

    it("rejects a malformed EVM address, Solana address and proof of possession", () => {
      const json = wireForm(fixtureDocument())
      json.operators[1].keys.ethereum.address = "0x1234"
      json.operators[1].keys.solana.address = "not-base58-0OIl"
      json.operators[0].keys.wireFinalizer.proofOfPossession = "BLS_proof"
      const issues = issuesOf(json)
      expect(issues.some(issue => issue.startsWith("operators.1.keys.ethereum.address"))).toBe(true)
      expect(issues.some(issue => issue.startsWith("operators.1.keys.solana.address"))).toBe(true)
      expect(
        issues.some(issue => issue.startsWith("operators.0.keys.wireFinalizer.proofOfPossession"))
      ).toBe(true)
    })

    it("rejects an empty or non-canonical account name", () => {
      const json = wireForm(fixtureDocument())
      json.operators[0].accountName = ""
      json.operators[1].accountName = "Not.A.Name"
      const issues = issuesOf(json)
      expect(issues.some(issue => issue.startsWith("operators.0.accountName"))).toBe(true)
      expect(issues.some(issue => issue.startsWith("operators.1.accountName"))).toBe(true)
    })

    it("requires at least one operator, one group, and one member per group", () => {
      const json = wireForm(fixtureDocument())
      json.operators = []
      json.batchOperatorGroups.groups = [[]]
      const issues = issuesOf(json)
      expect(issues.some(issue => issue.startsWith("operators:"))).toBe(true)
      expect(issues.some(issue => issue.startsWith("batchOperatorGroups.groups.0"))).toBe(true)
    })

    it("admits a null label and a null AWS account", () => {
      const document = { ...fixtureDocument(), label: null, awsAccount: null },
        json = wireForm(document)
      expect(json).toMatchObject({ label: null, awsAccount: null })
      expect(WireOpregBootstrapSchemaCodec.deserialize(JSON.stringify(json))).toEqual(document)
    })

    it("rejects a label outside the workflow's grammar", () => {
      const json = wireForm(fixtureDocument())
      json.label = "Testnet Epoch 60"
      expect(issuesOf(json).some(issue => issue.startsWith("label"))).toBe(true)
    })

    it("rejects an AWS account that is not an AWSAccountName", () => {
      const json = wireForm(fixtureDocument())
      json.awsAccount = "staging"
      expect(issuesOf(json).some(issue => issue.startsWith("awsAccount"))).toBe(true)
    })

    it("requires the label and AWS account keys to be present (null, not absent)", () => {
      const json = wireForm(fixtureDocument())
      delete json.label
      delete json.awsAccount
      const issues = issuesOf(json)
      expect(issues.some(issue => issue.startsWith("label"))).toBe(true)
      expect(issues.some(issue => issue.startsWith("awsAccount"))).toBe(true)
    })

    it("requires a positive integer epoch duration", () => {
      const json = wireForm(fixtureDocument())
      json.epochDurationSec = 0
      expect(issuesOf(json).some(issue => issue.startsWith("epochDurationSec"))).toBe(true)
    })
  })

  describe("consistency rules", () => {
    it("rejects a duplicate accountName", () => {
      const json = wireForm(fixtureDocument())
      json.operators[2].accountName = json.operators[1].accountName
      expect(issuesOf(json)).toContain(
        `operators.2.accountName: duplicate accountName ${BatchAccounts[0]}`
      )
    })

    it("rejects an activeGroupIndex past the last group", () => {
      const json = wireForm(fixtureDocument())
      json.batchOperatorGroups.activeGroupIndex = BatchAccounts.length
      expect(issuesOf(json)).toContain(
        `batchOperatorGroups.activeGroupIndex: activeGroupIndex ${BatchAccounts.length} is out of range for ${BatchAccounts.length} group(s)`
      )
    })

    it("rejects the same account twice within one group", () => {
      const json = wireForm(fixtureDocument())
      json.batchOperatorGroups.groups[0] = [BatchAccounts[0], BatchAccounts[0]]
      expect(issuesOf(json)).toContain(
        `batchOperatorGroups.groups.0.1: ${BatchAccounts[0]} appears more than once in group 0`
      )
    })

    it("accepts one operator in several groups (cross-group membership is the depot's concern)", () => {
      const json = wireForm(fixtureDocument())
      json.batchOperatorGroups.groups[1] = [BatchAccounts[0]]
      expect(WireOpregBootstrapSchemaCodec.check(json)).toBe(true)
    })

    it("rejects a group member that is not a BATCH operator in operators", () => {
      const json = wireForm(fixtureDocument())
      json.batchOperatorGroups.groups[0] = [ProducerAccount]
      json.batchOperatorGroups.groups[1] = ["wireno.zzzzz"]
      const issues = issuesOf(json)
      expect(issues).toContain(
        `batchOperatorGroups.groups.0.0: group member ${ProducerAccount} is not a BATCH operator in operators`
      )
      expect(issues).toContain(
        "batchOperatorGroups.groups.1.0: group member wireno.zzzzz is not a BATCH operator in operators"
      )
    })

  })

  describe("per-type key slots", () => {
    it("requires wireFinalizer on a PRODUCER and ethereum + solana on a BATCH operator", () => {
      const json = wireForm(fixtureDocument())
      delete json.operators[0].keys.wireFinalizer
      delete json.operators[1].keys.ethereum
      delete json.operators[1].keys.solana
      const issues = issuesOf(json)
      expect(issues.some(issue => issue.startsWith("operators.0.keys.wireFinalizer:"))).toBe(true)
      expect(issues.some(issue => issue.startsWith("operators.1.keys.ethereum:"))).toBe(true)
      expect(issues.some(issue => issue.startsWith("operators.1.keys.solana:"))).toBe(true)
    })

    it("rejects a key slot the operator's type does not carry", () => {
      const json = wireForm(fixtureDocument())
      json.operators[1].keys.wireFinalizer = json.operators[0].keys.wireFinalizer
      json.operators[0].keys.ethereum = json.operators[1].keys.ethereum
      const issues = issuesOf(json)
      expect(issues.some(issue => issue.startsWith("operators.0.keys:") && issue.includes("ethereum"))).toBe(true)
      expect(issues.some(issue => issue.startsWith("operators.1.keys:") && issue.includes("wireFinalizer"))).toBe(true)
    })

    it("admits an UNDERWRITER entry carrying the batch-operator key slots", () => {
      const json = wireForm(fixtureDocument())
      json.operators.push({ ...json.operators[1], accountName: "wireno.u1w2r", type: "UNDERWRITER" })
      expect(WireOpregBootstrapSchemaCodec.check(json)).toBe(true)
    })
  })

  describe("JSON Schema", () => {
    it("carries the document title and description", () => {
      const schema = WireOpregBootstrapSchemaCodec.toJSONSchema()
      expect(schema.title).toBe(WireOpregBootstrap.Title)
      expect(schema.description).toBe(WireOpregBootstrap.Description)
      expect(schema.required).toEqual([
        "label",
        "awsAccount",
        "epochDurationSec",
        "operators",
        "batchOperatorGroups"
      ])
    })

    it("carries one operator variant per type, each with exactly its key slots and pinned curves", () => {
      const oppOperatorKeys = {
          required: ["wire", "ethereum", "solana"],
          additionalProperties: false,
          properties: {
            wire: { properties: { type: { const: KeyType.K1 } } },
            ethereum: { properties: { type: { const: KeyType.EM } } },
            solana: { properties: { type: { const: KeyType.ED } } }
          }
        },
        variant = (name: string, keys: object) => ({
          properties: { type: { enum: [name] }, keys }
        })
      expect(WireOpregBootstrapSchemaCodec.toJSONSchema()).toMatchObject({
        properties: {
          operators: {
            items: {
              oneOf: [
                variant("PRODUCER", {
                  required: ["wire", "wireFinalizer"],
                  additionalProperties: false,
                  properties: {
                    wire: { properties: { type: { const: KeyType.K1 } } },
                    wireFinalizer: { properties: { type: { const: KeyType.BLS } } }
                  }
                }),
                variant("BATCH", oppOperatorKeys),
                variant("UNDERWRITER", oppOperatorKeys)
              ]
            }
          }
        }
      })
    })
  })
})
