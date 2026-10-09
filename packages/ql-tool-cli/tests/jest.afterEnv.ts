import { unmountTui } from "./common/renderTui.js"
import { removeTemporaryDirectories } from "./common/temporaryDirectory.js"

// One live TUI per test: unmount whatever a test rendered so its key handlers
// never receive the next test's presses.
afterEach(() => unmountTui())

// Temp directories a test file made (stores, logs, outputs) do not outlive it.
afterAll(() => removeTemporaryDirectories())
