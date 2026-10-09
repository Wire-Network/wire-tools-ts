import "@testing-library/jest-dom"

import { TempDirectory } from "./common/TempDirectory.js"

// Every suite's scratch directories (the bind-registry sandbox included) are removed once, after its last test.
afterAll(() => TempDirectory.removeAll())
