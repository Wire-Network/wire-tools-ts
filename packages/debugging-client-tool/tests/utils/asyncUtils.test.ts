import { sleep } from "@wireio/debugging-client-tool/utils"

describe("asyncUtils.sleep", () => {
  it("resolves after at least the requested delay", async () => {
    const start = Date.now()
    await sleep(30)
    expect(Date.now() - start).toBeGreaterThanOrEqual(25)
  })

  it("resolves (does not reject) for a zero delay", async () => {
    await expect(sleep(0)).resolves.toBeUndefined()
  })
})
