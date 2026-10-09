import Path from "node:path"

import { E2EPaths } from "./common/E2EPaths.js"
import { QLAppHarness } from "./common/QLAppHarness.js"
import { VirtualDisplay } from "./common/VirtualDisplay.js"

/** The display's pid record: beside Playwright's outputDir, which Playwright wipes BEFORE globalSetup runs. */
export const VirtualDisplayRecordFile = Path.join(E2EPaths.TestResultsPath, VirtualDisplay.RecordFilename)

/**
 * Reap a display an interrupted previous run left behind (its record survives
 * in `dist/test-results/`), then start the X display every e2e launch uses
 * (Xvfb, else nested Xephyr — under a watchdog that ends it when this runner
 * exits for any reason) and publish it as `WIRE_QL_E2E_DISPLAY`; the returned
 * teardown stops it and awaits its exit.
 *
 * @returns Teardown.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  await VirtualDisplay.reapStale(VirtualDisplayRecordFile)
  const display = await VirtualDisplay.start(VirtualDisplayRecordFile)
  process.env[QLAppHarness.DisplayEnvironmentVariable] = display.name
  return () => display.stop()
}
