import { SSMClientProvider } from "@wireio/cluster-tool/config"

const mockSend = jest.fn()
jest.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  GetParameterCommand: jest
    .fn()
    .mockImplementation((input: unknown) => ({ kind: "GetParameter", input })),
  PutParameterCommand: jest
    .fn()
    .mockImplementation((input: unknown) => ({ kind: "PutParameter", input })),
  DeleteParameterCommand: jest
    .fn()
    .mockImplementation((input: unknown) => ({ kind: "DeleteParameter", input }))
}))

/** The captured input of the single command sent for the last call. */
function lastCommandInput(): Record<string, unknown> {
  return mockSend.mock.calls[0][0].input as Record<string, unknown>
}

describe("SSMClientProvider (jest module mock — no live AWS)", () => {
  beforeEach(() => mockSend.mockReset())

  describe("getParameter", () => {
    it("requests WithDecryption and returns the trimmed SecureString value", async () => {
      mockSend.mockResolvedValueOnce({
        Parameter: { Type: "SecureString", Value: "  the-secret  " }
      })
      const value = await SSMClientProvider.getParameter(
        "us-east-1",
        "/wire/keys/a"
      )
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
      await expect(
        SSMClientProvider.getParameter("us-east-1", "/wire/keys/a")
      ).rejects.toThrow(/must be a SecureString/)
    })

    it("rejects a missing parameter", async () => {
      mockSend.mockResolvedValueOnce({})
      await expect(
        SSMClientProvider.getParameter("us-east-1", "/wire/keys/a")
      ).rejects.toThrow(/not found/)
    })

    it("rejects an empty (whitespace-only) value", async () => {
      mockSend.mockResolvedValueOnce({
        Parameter: { Type: "SecureString", Value: "   " }
      })
      await expect(
        SSMClientProvider.getParameter("us-east-1", "/wire/keys/a")
      ).rejects.toThrow(/is empty/)
    })
  })

  describe("putParameter", () => {
    it("publishes a SecureString with Overwrite", async () => {
      mockSend.mockResolvedValueOnce({})
      await SSMClientProvider.putParameter(
        "us-west-2",
        "/wire/keys/b",
        "the-private-key"
      )
      expect(lastCommandInput()).toEqual({
        Name: "/wire/keys/b",
        Value: "the-private-key",
        Type: "SecureString",
        Overwrite: true
      })
    })
  })

  describe("deleteParameter", () => {
    it("deletes by name", async () => {
      mockSend.mockResolvedValueOnce({})
      await SSMClientProvider.deleteParameter("eu-west-1", "/wire/keys/c")
      expect(lastCommandInput()).toEqual({ Name: "/wire/keys/c" })
    })
  })
})
