/**
 * Controllable stand-ins for the Electron APIs the app touches. Jest suites never
 * need the Electron binary: every `import … from "electron"` resolves here
 * (moduleNameMapper). Each fake records calls with jest.fn and exposes the hooks
 * a test needs (emit `spawn`/`exit`, close ports, pick a dialog result).
 */
import { EventEmitter } from "node:events"
import Os from "node:os"
import Path from "node:path"

/** A fake MessagePortMain (records posts and closes). */
export class FakeMessagePort extends EventEmitter {
  /** Whether close() ran. */
  closed = false
  /** Messages posted. */
  readonly posted: unknown[] = []
  start = jest.fn()
  close = jest.fn(() => {
    this.closed = true
  })
  postMessage = jest.fn((message: unknown) => {
    this.posted.push(message)
  })
}

/** A fake MessageChannelMain; every instance is recorded in {@link MessageChannelMain.created}. */
export class MessageChannelMain {
  /** Every channel constructed. */
  static readonly created: MessageChannelMain[] = []
  readonly port1 = new FakeMessagePort()
  readonly port2 = new FakeMessagePort()
  constructor() {
    MessageChannelMain.created.push(this)
  }
}

/** One posted control message with its transfer list. */
export interface FakePosted {
  message: unknown
  transfer: FakeMessagePort[]
}

/** A fake UtilityProcess (tests emit `spawn` / `exit` / `error`). */
export class FakeUtilityProcess extends EventEmitter {
  private static nextPid = 10_000
  readonly pid = FakeUtilityProcess.nextPid++
  /** Control messages posted. */
  readonly posted: FakePosted[] = []
  kill = jest.fn(() => true)
  postMessage = jest.fn((message: unknown, transfer: FakeMessagePort[] = []) => {
    this.posted.push({ message, transfer })
  })
}

/** Fake utilityProcess module: every fork is recorded. */
export const utilityProcess = {
  forked: [] as FakeUtilityProcess[],
  fork: jest.fn(() => {
    const child = new FakeUtilityProcess()
    utilityProcess.forked.push(child)
    return child
  })
}

/** The base directory of fake app paths. */
const AppPathRoot = Path.join(Os.tmpdir(), "ql-tool-app-electron-mock")

/** Fake app module. */
export const app = {
  getPath: jest.fn((name: string) => Path.join(AppPathRoot, name)),
  setPath: jest.fn(),
  setAppLogsPath: jest.fn(),
  requestSingleInstanceLock: jest.fn(() => true),
  quit: jest.fn(),
  exit: jest.fn(),
  on: jest.fn(),
  whenReady: jest.fn(() => Promise.resolve()),
  setAboutPanelOptions: jest.fn(),
  getAppMetrics: jest.fn(() => []),
  isPackaged: false,
  dock: { setIcon: jest.fn() }
}

/** Fake nativeTheme. */
export const nativeTheme = Object.assign(new EventEmitter(), { themeSource: "system", shouldUseDarkColors: false })

/** A fake built menu. */
export interface FakeMenu {
  template: unknown[]
  popup: jest.Mock
}

/** Fake Menu. */
export const Menu = {
  buildFromTemplate: jest.fn((template: unknown[]): FakeMenu => ({ template, popup: jest.fn() })),
  setApplicationMenu: jest.fn()
}

/** Fake dialog. */
export const dialog = { showOpenDialog: jest.fn(), showSaveDialog: jest.fn() }

/** Fake screen (one 1920×1080 display). */
export const screen = { getAllDisplays: jest.fn(() => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }]) }

/** Fake webContents. */
export class FakeWebContents extends EventEmitter {
  private static nextId = 1
  readonly id = FakeWebContents.nextId++
  destroyed = false
  send = jest.fn()
  postMessage = jest.fn()
  setWindowOpenHandler = jest.fn()
  isDestroyed = jest.fn(() => this.destroyed)
}

/** Fake BrowserWindow (records every instance). */
export class BrowserWindow extends EventEmitter {
  static readonly instances: BrowserWindow[] = []
  static getAllWindows = jest.fn(() => BrowserWindow.instances)
  static getFocusedWindow = jest.fn(() => BrowserWindow.instances[0])
  static fromWebContents = jest.fn((webContents: FakeWebContents) =>
    BrowserWindow.instances.find(window => window.webContents === webContents)
  )
  /** What every instance's `loadURL` returns (tests make it reject). */
  static loadURLResult = jest.fn((): Promise<void> => Promise.resolve())
  readonly webContents = new FakeWebContents()
  bounds = { x: 0, y: 0, width: 800, height: 600 }
  maximized = false
  loadURL = jest.fn(() => BrowserWindow.loadURLResult())
  maximize = jest.fn(() => {
    this.maximized = true
  })
  show = jest.fn()
  focus = jest.fn()
  restore = jest.fn()
  isMinimized = jest.fn(() => false)
  isMaximized = jest.fn(() => this.maximized)
  getNormalBounds = jest.fn(() => this.bounds)
  constructor(readonly options: Record<string, unknown> = {}) {
    super()
    BrowserWindow.instances.push(this)
  }
}

/** Fake ipcMain. */
export const ipcMain = { handle: jest.fn(), on: jest.fn() }

/** Fake ipcRenderer. */
export const ipcRenderer = Object.assign(new EventEmitter(), {
  invoke: jest.fn(() => Promise.resolve()),
  send: jest.fn()
})

/** Fake contextBridge. */
export const contextBridge = { exposeInMainWorld: jest.fn() }

/** Fake session. */
export const session = { defaultSession: { webRequest: { onHeadersReceived: jest.fn() } } }
