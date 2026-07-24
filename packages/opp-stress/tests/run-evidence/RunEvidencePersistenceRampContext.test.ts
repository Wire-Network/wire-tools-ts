import {
  RunEvidencePersistence,
  RunEvidencePersistenceErrorCode
} from "@wireio/test-opp-stress"

import {
  allocationDependencies,
  allocationOptions,
  allocateRunningPersistence,
  breakageIteration,
  createPersistenceWorkspace
} from "./runEvidencePersistenceTestSupport.js"

describe("RunEvidencePersistence active ramp context", () => {
  it("returns only immutable allocation authority for fresh successful setup", async () => {
    // Given: setup succeeded and no iteration or terminal has committed.
    const workspace = createPersistenceWorkspace(),
      persistence = await allocateRunningPersistence(workspace)
    try {
      // When: the controller synchronously requires its active context.
      const context = persistence.requireActiveRampContext()
      // Then: only frozen allocation authority is exposed.
      expect(context).toEqual({
        startedAtMs: "100",
        rampConfig: allocationOptions(workspace).rampConfig,
        requiredEndpoints: allocationOptions(workspace).requiredEndpoints
      })
      expect(Object.keys(context).sort()).toEqual([
        "rampConfig",
        "requiredEndpoints",
        "startedAtMs"
      ])
      expect(Object.isFrozen(context)).toBe(true)
      expect(Object.isFrozen(context.rampConfig)).toBe(true)
      expect(Object.isFrozen(context.requiredEndpoints)).toBe(true)
    } finally {
      workspace.cleanup()
    }
  })

  it("rejects readiness before successful setup and after an iteration", async () => {
    // Given: one allocated run and one independently active run.
    const unreadyWorkspace = createPersistenceWorkspace(),
      activeWorkspace = createPersistenceWorkspace(),
      unready = await RunEvidencePersistence.allocate(
        allocationOptions(unreadyWorkspace),
        allocationDependencies()
      ),
      active = await allocateRunningPersistence(activeWorkspace)
    try {
      // When: readiness is required outside the fresh-running state.
      expect(() => unready.requireActiveRampContext()).toThrow(
        expect.objectContaining({
          code: RunEvidencePersistenceErrorCode.InvalidState
        })
      )
      const publication = active.publishIteration(breakageIteration(0))
      expect(() => active.requireActiveRampContext()).toThrow(
        expect.objectContaining({
          code: RunEvidencePersistenceErrorCode.InvalidState
        })
      )
      await publication
      // Then: queued and committed iterations make a second controller start invalid.
      expect(() => active.requireActiveRampContext()).toThrow(
        expect.objectContaining({
          code: RunEvidencePersistenceErrorCode.InvalidState
        })
      )
    } finally {
      unreadyWorkspace.cleanup()
      activeWorkspace.cleanup()
    }
  })
})
