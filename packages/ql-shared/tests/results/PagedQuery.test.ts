import { PagedQuery, PageSizeMode, QueryEngineClient, QueryPager } from "@wireio/ql-shared"

import { createProfile } from "../common/profileFixtures.js"

describe("PagedQuery", () => {
  it("forwards the pager window as limit/offset", async () => {
    const client = new QueryEngineClient(createProfile()),
      execute = jest.spyOn(client, "execute").mockResolvedValue(undefined),
      paged = new PagedQuery(client, "SELECT x FROM a.b"),
      controller = new AbortController()
    await paged.fetch(new QueryPager({ pageSize: 10, page: 3 }), { signal: controller.signal, limit: 999 })
    expect(execute).toHaveBeenCalledWith("SELECT x FROM a.b", { signal: controller.signal, limit: 10, offset: 20 })
  })

  it("all mode sends no limit", async () => {
    const client = new QueryEngineClient(createProfile()),
      execute = jest.spyOn(client, "execute").mockResolvedValue(undefined)
    await new PagedQuery(client, "q").fetch(new QueryPager({ mode: PageSizeMode.all }))
    expect(execute).toHaveBeenCalledWith("q", { limit: null, offset: 0 })
    expect(new PagedQuery(client, "q").query).toBe("q")
  })
})
