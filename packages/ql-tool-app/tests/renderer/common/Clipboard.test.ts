import { Clipboard } from "@wireio/ql-tool-app/renderer/common"

/**
 * Install a fake `navigator.clipboard` whose write runs `writeText`.
 *
 * @param writeText - The fake write.
 */
function installClipboard(writeText: jest.Mock): void {
  Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText } }, configurable: true })
}

describe("Clipboard.copy", () => {
  it("writes the text and reports success", async () => {
    const writeText = jest.fn(async (_text: string) => undefined)
    installClipboard(writeText)
    await expect(Clipboard.copy("alice")).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith("alice")
  })

  it("a refused write resolves false instead of throwing", async () => {
    installClipboard(jest.fn(async () => Promise.reject(new Error("not allowed"))))
    await expect(Clipboard.copy("alice")).resolves.toBe(false)
  })
})
