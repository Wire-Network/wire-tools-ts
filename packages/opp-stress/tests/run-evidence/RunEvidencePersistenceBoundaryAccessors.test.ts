import {
  RunEvidencePersistence,
  RunEvidencePersistenceErrorCode
} from "@wireio/test-opp-stress"

import {
  allocationDependencies,
  allocationOptions,
  createPersistenceWorkspace,
  successfulSetup
} from "./runEvidencePersistenceTestSupport.js"

describe("RunEvidencePersistence boundary accessors", () => {
  it("rejects a setup accessor before schema parsing can invoke it", async () => {
    // Given: an allocated run and setup record with an observable status getter.
    const workspace = createPersistenceWorkspace()
    let getterCalls = 0
    try {
      const persistence = await RunEvidencePersistence.allocate(
          allocationOptions(workspace),
          allocationDependencies()
        ),
        setup = Object.defineProperty({ ...successfulSetup() }, "status", {
          enumerable: true,
          get: () => {
            getterCalls += 1
            return successfulSetup().status
          }
        })
      // When/Then: descriptor parsing rejects without executing untrusted code.
      await expect(persistence.publishSetup(setup)).rejects.toMatchObject({
        name: "RunEvidencePersistenceError",
        code: RunEvidencePersistenceErrorCode.UnsupportedJson
      })
      expect(getterCalls).toBe(0)
    } finally {
      workspace.cleanup()
    }
  })
})
