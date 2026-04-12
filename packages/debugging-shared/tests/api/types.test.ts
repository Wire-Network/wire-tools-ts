import type {
  InferredRequestType,
  InferredResponseType
} from "@wire-e2e-tests/debugging-shared"
import { ApiPaths } from "@wire-e2e-tests/debugging-shared"

describe("ApiPaths", () => {
  it("Ping is /api/ping", () => {
    expect(ApiPaths.Ping).toBe("/api/ping")
  })

  it("Opp.Envelope is /api/opp/envelope", () => {
    expect(ApiPaths.OPP.Envelope).toBe("/api/opp/envelope")
  })
})

describe("InferredRequestType", () => {
  it("infers PutEnvelopeRequest for Opp.Envelope path", () => {
    const sample: InferredRequestType<typeof ApiPaths.OPP.Envelope> = {
      batchOpName: "batchop.a",
      endpointsType: 1,
      envelopeData: new Uint8Array(0)
    }
    expect(sample).toHaveProperty("batchOpName")
    expect(sample).toHaveProperty("endpointsType")
    expect(sample).toHaveProperty("envelopeData")
  })
})

describe("InferredResponseType", () => {
  it("infers PutEnvelopeResponse for Opp.Envelope path", () => {
    const sample: InferredResponseType<typeof ApiPaths.OPP.Envelope> = {
      key: "00000001-TEST-abc123",
      dataExisted: false,
      batchOpNames: ["batchop.a"]
    }
    expect(sample).toHaveProperty("key")
    expect(sample).toHaveProperty("dataExisted")
    expect(sample).toHaveProperty("batchOpNames")
  })
})
