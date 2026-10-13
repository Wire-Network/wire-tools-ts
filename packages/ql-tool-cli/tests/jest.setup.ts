import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"

// Sandbox the cross-process bind-port registry (BindConfigProvider.RegistryPathEnvVar)
// so stub-server port claims neither read live runs' reservations nor write the real
// host registry. The sandbox is SHARED by every worker of one jest run (keyed by the
// jest parent pid): parallel test files claim stub ports against one registry, so
// two workers never pick the same port.
process.env.WIRE_BIND_REGISTRY_PATH = Path.join(Os.tmpdir(), `wire-bind-registry-test-ql-tool-cli-${process.ppid}`)
Fs.mkdirSync(process.env.WIRE_BIND_REGISTRY_PATH, { recursive: true })

// react-test-renderer drives the TUI components under React's act() environment.
// IS_REACT_NATIVE_TEST_ENVIRONMENT makes it create synchronous (legacy) roots and
// skips its per-create deprecation notice — it is the renderer these CJS tests can
// load (ink-testing-library is ESM-only).
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, IS_REACT_NATIVE_TEST_ENVIRONMENT: true })

/** Ink `useInput` options as the mock reads them. */
interface InkInputOptions {
  isActive?: boolean
}

/** A key handler registered through the mocked `useInput`. */
type InkInputHandler = (input: string, key: Record<string, boolean>) => void

// `ink` is ESM-only with top-level await (yoga) — it cannot load under jest's CJS
// runtime. wql's components render through this mock: host components become plain
// string elements (rendered by react-test-renderer); `useInput` registers handlers
// the way Ink does (active ones receive every press) so tests drive real key flows
// through `__press`; the other hooks are jest.fn with stable return values.
jest.mock("ink", () => {
  const React = require("react")
  const host = (name: string) => (props: Record<string, unknown>) => React.createElement(name, props, props.children)
  const handlers = new Set<InkInputHandler>()
  const exit = jest.fn()
  const write = jest.fn()
  const { keyFlags } = require("./common/inkKeys")
  return {
    __esModule: true,
    Box: host("Box"),
    Text: host("Text"),
    Newline: host("Newline"),
    Spacer: host("Spacer"),
    useApp: jest.fn(() => ({ exit })),
    useInput: jest.fn((handler: InkInputHandler, options: InkInputOptions = {}) => {
      const ref = React.useRef(handler)
      ref.current = handler
      React.useEffect(() => {
        if (options.isActive === false) return undefined
        const entry = (input: string, key: Record<string, boolean>) => ref.current(input, key)
        handlers.add(entry)
        return () => {
          handlers.delete(entry)
        }
      }, [options.isActive])
    }),
    useStdout: jest.fn(() => ({ stdout: { columns: 120, rows: 40 }, write })),
    useWindowSize: jest.fn(() => ({ columns: 120, rows: 40 })),
    render: jest.fn(() => ({
      unmount: jest.fn(),
      rerender: jest.fn(),
      clear: jest.fn(),
      cleanup: jest.fn(),
      waitUntilExit: () => Promise.resolve()
    })),
    /** Test hook: deliver one keypress to every active handler. */
    __press: (input: string, key: Record<string, boolean> = {}) => {
      const full = keyFlags(key)
      ;[...handlers].forEach(handler => handler(input, full))
    },
    /** Test hook: active handler count. */
    __handlerCount: () => handlers.size,
    /** Test hook: the shared `useApp().exit`. */
    __exit: exit,
    /** Test hook: the shared `useStdout().write`. */
    __write: write
  }
})
