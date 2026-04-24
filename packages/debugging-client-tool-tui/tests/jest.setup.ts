/**
 * Jest setup for the TUI package.
 *
 * `ink` is distributed ESM-only since v5, and its components pull in tty/ansi
 * helpers that misbehave under jest's CJS runtime. For unit tests we replace
 * Ink's exported components with plain string tags and stub the hooks. Tests
 * that exercise real rendering live elsewhere (smoke-tests via the bundled
 * binary) — see plan §10.
 */

jest.mock("ink", () => {
  const React = require("react")
  const passthrough = (name: string) =>
    (props: any) => React.createElement(name, props, props?.children)
  return {
    __esModule: true,
    Box: passthrough("Box"),
    Text: passthrough("Text"),
    Static: passthrough("Static"),
    Newline: passthrough("Newline"),
    Spacer: passthrough("Spacer"),
    useApp: () => ({ exit: jest.fn() }),
    useInput: jest.fn(),
    useFocus: () => ({ isFocused: false, focus: jest.fn() }),
    useFocusManager: () => ({
      enableFocus: jest.fn(),
      disableFocus: jest.fn(),
      focus: jest.fn(),
      focusNext: jest.fn(),
      focusPrevious: jest.fn()
    }),
    useStdin: () => ({
      stdin: process.stdin,
      setRawMode: jest.fn(),
      isRawModeSupported: true,
      internal_exitOnCtrlC: false
    }),
    useStdout: () => ({ stdout: process.stdout, write: jest.fn() }),
    useStderr: () => ({ stderr: process.stderr, write: jest.fn() }),
    useWindowSize: () => ({ columns: 80, rows: 24 }),
    render: jest.fn(() => ({
      unmount: jest.fn(),
      rerender: jest.fn(),
      clear: jest.fn(),
      waitUntilExit: () => Promise.resolve()
    }))
  }
})
