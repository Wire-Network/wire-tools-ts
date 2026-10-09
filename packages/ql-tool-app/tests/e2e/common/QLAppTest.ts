import { expect, test as base } from "@playwright/test"

import { StubQueryEngine } from "../../common/StubQueryEngine.js"
import { TempDirectory } from "../../common/TempDirectory.js"
import { QLAppHarness, type QLAppLaunchOptions, type QLAppSession } from "./QLAppHarness.js"

/** What a spec's `launch` takes: the harness options, with the isolated root defaulted. */
export interface QLAppTestLaunchOptions extends Partial<QLAppLaunchOptions> {}

/** Launches the app; every session is closed (and its root removed) when the test ends. */
export type QLAppLauncher = (options?: QLAppTestLaunchOptions) => Promise<QLAppSession>

/** Test-scoped fixtures of the e2e specs. */
export interface QLAppTestFixtures {
  /** Launch an isolated app (a new root unless `rootPath` is given; `endpoint` defaults to the stub). */
  launch: QLAppLauncher
  /** Launch an isolated app against the stub and wait for its query port. */
  launchConnected: QLAppLauncher
}

/** Worker-scoped fixtures of the e2e specs. */
export interface QLAppWorkerFixtures {
  /** The stub query engine every test of the worker runs against. */
  stub: StubQueryEngine
}

/**
 * The e2e `test`: one stub engine per worker, and launchers whose sessions are
 * closed — exit awaited — and whose temp roots are removed in the fixture
 * teardown, whatever the test's outcome.
 */
export const test = base.extend<QLAppTestFixtures, QLAppWorkerFixtures>({
  // Playwright requires a destructured fixtures argument; the stub depends on none of them.
  stub: [
    async ({ playwright: _playwright }, use) => {
      const stub = await StubQueryEngine.start()
      await use(stub)
      await stub.close()
    },
    { scope: "worker" }
  ],
  launch: async ({ stub }, use) => {
    const running = new Set<QLAppSession>()
    await use(async (options = {}) => {
      const { rootPath = QLAppHarness.createRoot(), endpoint = stub.url, ...rest } = options,
        session = await QLAppHarness.launch({ ...rest, rootPath, endpoint })
      running.add(session)
      // A session the test closes itself (a relaunch) leaves the set, so teardown never closes it twice.
      session.app.once(QLAppTest.CloseEvent, () => running.delete(session))
      return session
    })
    await Promise.all([...running].map(session => session.app.close()))
    TempDirectory.removeAll()
  },
  launchConnected: async ({ launch }, use) => {
    await use(async options => {
      const session = await launch(options)
      await expect(session.page.getByTestId(QLAppTest.HostConnectedTestId)).toBeVisible()
      return session
    })
  }
})

/** e2e fixture constants. */
export namespace QLAppTest {
  /** The status-bar element shown once the query port is connected. */
  export const HostConnectedTestId = "host-connected"
  /** `ElectronApplication` event once the app has closed. */
  export const CloseEvent = "close"
}
