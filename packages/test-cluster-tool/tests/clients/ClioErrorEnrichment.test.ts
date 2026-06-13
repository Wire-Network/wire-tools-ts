import { enrichClioError } from "@wireio/test-cluster-tool"

describe("enrichClioError", () => {
  const ASSERT_LINE =
    'assertion failure with message: matchreserve: matcher has no authex link for the reserve\'s chain'

  it("folds the child's stdout (where clio -j prints chain asserts) into the message", () => {
    const err = new Error("Command failed: clio push action sysio.reserv matchreserve ...")
    const enriched = enrichClioError(err, ASSERT_LINE, "") as Error

    expect(enriched).toBe(err) // same object — properties preserved
    expect(enriched.message).toMatch(/Command failed/)
    expect(enriched.message).toMatch(/matcher has no authex link/)
  })

  it("folds stderr too and skips empty streams", () => {
    const err = new Error("Command failed")
    enrichClioError(err, "", "wallet locked")
    expect(err.message).toBe("Command failed\nwallet locked")
  })

  it("leaves the message untouched when both streams are empty", () => {
    const err = new Error("Command failed")
    enrichClioError(err, "", "")
    expect(err.message).toBe("Command failed")
  })

  it("returns non-Error values unchanged", () => {
    const notAnError = { code: 1 }
    expect(enrichClioError(notAnError, ASSERT_LINE, "")).toBe(notAnError)
  })
})
