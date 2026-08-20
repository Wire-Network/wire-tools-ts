import { SSMClientProvider } from "@wireio/cluster-tool/config"

const mockSend = jest.fn()
// `mock`-prefixed so jest's factory hoisting allows the reference — holding the
// constructor here (rather than re-requiring the module) guarantees it is the
// SAME jest.fn the provider's dynamic import receives.
const mockSSMClient = jest.fn().mockImplementation(() => ({ send: mockSend }))
jest.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: mockSSMClient,
  GetParameterCommand: jest.fn().mockImplementation((input: unknown) => ({ kind: "GetParameter", input })),
  PutParameterCommand: jest.fn().mockImplementation((input: unknown) => ({ kind: "PutParameter", input }))
}))

/** The captured input of the single command sent for the last call. */
function lastCommandInput(): Record<string, unknown> {
  return mockSend.mock.calls[0][0].input as Record<string, unknown>
}

/** An AWS SDK service exception — identified by its `name`, as the SDK does. */
function ssmError(name: string, message: string): Error {
  return Object.assign(new Error(message), { name })
}

/** A `ParameterNotFound` rejection — the ONLY failure that means "unpublished". */
function parameterNotFound(secretId: string): Error {
  return ssmError("ParameterNotFound", `Parameter ${secretId} not found.`)
}

/** A resolved `GetParameter` response carrying `value`. */
function secureStringResponse(value: string): Record<string, unknown> {
  return { Parameter: { Type: "SecureString", Value: value } }
}

/** The client config `SSMClient` is constructed with (region omitted = ambient). */
interface SSMClientConfig {
  region?: string
  retryMode?: string
  maxAttempts?: number
}

/** The client config `SSMClient` was constructed with for `region`'s cache entry. */
function clientConfigFor(region: string): SSMClientConfig {
  const call = mockSSMClient.mock.calls.find(([config]: [SSMClientConfig]) =>
    region === SSMClientProvider.AmbientRegion ? config?.region == null : config?.region === region
  )
  return call?.[0]
}

describe("SSMClientProvider (jest module mock — no live AWS)", () => {
  beforeEach(() => mockSend.mockReset())

  describe("getParameter", () => {
    it("requests WithDecryption and returns the trimmed SecureString value", async () => {
      mockSend.mockResolvedValueOnce(secureStringResponse("  the-secret  "))
      const value = await SSMClientProvider.getParameter("us-east-1", "/wire/keys/a")
      expect(value).toBe("the-secret")
      expect(lastCommandInput()).toEqual({
        Name: "/wire/keys/a",
        WithDecryption: true
      })
    })

    it("rejects a non-SecureString parameter", async () => {
      mockSend.mockResolvedValueOnce({
        Parameter: { Type: "String", Value: "x" }
      })
      await expect(SSMClientProvider.getParameter("us-east-1", "/wire/keys/a")).rejects.toThrow(
        /must be a SecureString/
      )
    })

    it("rejects a missing parameter", async () => {
      mockSend.mockResolvedValueOnce({})
      await expect(SSMClientProvider.getParameter("us-east-1", "/wire/keys/a")).rejects.toThrow(/not found/)
    })

    it("rejects an empty (whitespace-only) value", async () => {
      mockSend.mockResolvedValueOnce(secureStringResponse("   "))
      await expect(SSMClientProvider.getParameter("us-east-1", "/wire/keys/a")).rejects.toThrow(/is empty/)
    })
  })

  describe("tryGetParameter (the D21 adopt probe)", () => {
    it("returns the value when the id IS published", async () => {
      mockSend.mockResolvedValueOnce(secureStringResponse("adopt-me"))
      await expect(SSMClientProvider.tryGetParameter("us-east-1", "/wire/keys/a")).resolves.toBe("adopt-me")
    })

    it("returns nothing on ParameterNotFound — the id is simply unpublished", async () => {
      mockSend.mockRejectedValueOnce(parameterNotFound("/wire/keys/a"))
      await expect(SSMClientProvider.tryGetParameter("us-east-1", "/wire/keys/a")).resolves.toBeNull()
    })

    it("RETHROWS every other SSM failure — AccessDenied is not 'nothing to adopt'", async () => {
      mockSend.mockRejectedValueOnce(ssmError("AccessDeniedException", "not authorized to perform ssm:GetParameter"))
      await expect(SSMClientProvider.tryGetParameter("us-east-1", "/wire/keys/a")).rejects.toThrow(/not authorized/)
    })

    it("RETHROWS a wrong-Type parameter rather than silently regenerating its key", async () => {
      mockSend.mockResolvedValueOnce({
        Parameter: { Type: "String", Value: "plaintext" }
      })
      await expect(SSMClientProvider.tryGetParameter("us-east-1", "/wire/keys/a")).rejects.toThrow(
        /must be a SecureString/
      )
    })
  })

  describe("getParameterAcrossRegions (the multi-region adopt read)", () => {
    const Regions = ["us-east-1", "eu-west-1", "ap-south-1"]

    it("adopts the FIRST hit when every region that has it agrees", async () => {
      mockSend
        .mockResolvedValueOnce(secureStringResponse("agreed"))
        .mockResolvedValueOnce(secureStringResponse("agreed"))
        .mockRejectedValueOnce(parameterNotFound("/wire/keys/b"))
      await expect(SSMClientProvider.getParameterAcrossRegions(Regions, "/wire/keys/b")).resolves.toBe("agreed")
      // Probed IN ORDER, once per region.
      expect(mockSend).toHaveBeenCalledTimes(Regions.length)
    })

    it("returns nothing when NO region holds the id", async () => {
      mockSend.mockRejectedValue(parameterNotFound("/wire/keys/b"))
      await expect(SSMClientProvider.getParameterAcrossRegions(Regions, "/wire/keys/b")).resolves.toBeNull()
    })

    it("HARD-FAILS on a divergence, naming the regions that disagree", async () => {
      mockSend
        .mockResolvedValueOnce(secureStringResponse("old-key"))
        .mockResolvedValueOnce(secureStringResponse("rotated-key"))
        .mockRejectedValueOnce(parameterNotFound("/wire/keys/b"))
      await expect(SSMClientProvider.getParameterAcrossRegions(Regions, "/wire/keys/b")).rejects.toThrow(
        /DIVERGES across regions — us-east-1 disagrees with eu-west-1/
      )
    })

    it("propagates a non-not-found failure instead of treating it as absence", async () => {
      mockSend.mockRejectedValueOnce(ssmError("ThrottlingException", "Rate exceeded"))
      await expect(SSMClientProvider.getParameterAcrossRegions(Regions, "/wire/keys/b")).rejects.toThrow(
        /Rate exceeded/
      )
    })
  })

  describe("putParameter", () => {
    it("publishes a SecureString with Overwrite FALSE (never rotates a live key)", async () => {
      mockSend.mockResolvedValueOnce({})
      await SSMClientProvider.putParameter("us-west-2", "/wire/keys/b", "the-private-key")
      expect(lastCommandInput()).toEqual({
        Name: "/wire/keys/b",
        Value: "the-private-key",
        Type: "SecureString",
        Overwrite: false
      })
      // No `Tags` key at all when none were supplied.
      expect(lastCommandInput()).not.toHaveProperty("Tags")
    })

    it("rides the tags on the PutParameter itself (legal once Overwrite is false)", async () => {
      mockSend.mockResolvedValueOnce({})
      await SSMClientProvider.putParameter("us-west-2", "/wire/keys/b", "the-private-key", [
        { Key: "wire:platform-version", Value: "v4" }
      ])
      expect(lastCommandInput().Tags).toEqual([{ Key: "wire:platform-version", Value: "v4" }])
    })
  })

  describe("delete", () => {
    it("has NO delete surface at all — destroy never removes a secret", () => {
      // D21: a published parameter is the AWS account's durable key identity the
      // next create ADOPTS. There is deliberately no deleteParameter to call.
      expect(SSMClientProvider).not.toHaveProperty("deleteParameter")
    })
  })

  describe("AmbientRegion (the region-less read)", () => {
    it("is the empty region, mirroring the depot plugin's region-less spec", () => {
      expect(SSMClientProvider.AmbientRegion).toBe("")
    })

    it("constructs its client WITHOUT a region so the AWS env chain supplies one", async () => {
      mockSend.mockResolvedValueOnce(secureStringResponse("ambient-secret"))
      const value = await SSMClientProvider.getParameter(SSMClientProvider.AmbientRegion, "/wire/keys/ambient")
      expect(value).toBe("ambient-secret")
      // `region: ""` would be a bad endpoint — the key must be absent entirely.
      expect(clientConfigFor(SSMClientProvider.AmbientRegion)).not.toHaveProperty("region")
      // A pinned region still pins.
      expect(clientConfigFor("us-east-1")).toMatchObject({
        region: "us-east-1"
      })
    })

    it("gives every client ADAPTIVE retry so a publication burst is paced, not dropped", async () => {
      mockSend.mockResolvedValueOnce(secureStringResponse("s"))
      await SSMClientProvider.getParameter("us-east-1", "/wire/keys/a")
      // A 21-producer cluster publishes >100 parameters back-to-back; Parameter
      // Store answers "Rate exceeded" and the SDK default (standard, 3 attempts)
      // loses the burst, aborting the build AFTER the platform is built.
      // `adaptive` adds the client-side rate limiter that paces the whole client.
      expect(clientConfigFor("us-east-1")).toMatchObject({
        retryMode: "adaptive",
        maxAttempts: 10
      })
    })

    it("names the ambient region in a not-found diagnostic (never an empty string)", async () => {
      mockSend.mockResolvedValueOnce({})
      await expect(
        SSMClientProvider.getParameter(SSMClientProvider.AmbientRegion, "/wire/keys/missing")
      ).rejects.toThrow(/not found in the ambient AWS region/)
    })
  })
})
