import { AppAction } from "./AppAction.js"

/** How one {@link AppAction} appears in native menus, context menus, tooltips and help text. */
export interface ActionDescriptor {
  /** Menu label. */
  label: string
  /** Electron accelerator (CmdOrCtrl maps to Cmd on macOS). */
  accelerator?: string
}

/**
 * The ONE table of action labels and accelerators. Native menus and context
 * menus read the descriptors, renderer tooltips / empty states read
 * {@link ActionRegistry.tooltip} / {@link ActionRegistry.acceleratorText}, and
 * the editor's key chords are parsed from the same accelerators — so every
 * surface names and binds an action identically. Pure (no Electron), so main
 * and the renderer share it.
 */
export namespace ActionRegistry {
  /** Row limit of the navigator's "Select Rows" (its label and its SQL). */
  export const SelectRowsLimit = 100
  /** The Electron accelerator modifier meaning Cmd on macOS and Ctrl elsewhere. */
  export const CmdOrCtrlModifier = "CmdOrCtrl"
  /** How {@link CmdOrCtrlModifier} reads in renderer text (the renderer does not know the host platform). */
  export const CmdOrCtrlText = "Ctrl/Cmd"
  /** Separator of accelerator parts. */
  export const AcceleratorSeparator = "+"

  /** Every action's descriptor. */
  export const Descriptors: Readonly<Record<AppAction, ActionDescriptor>> = {
    [AppAction.none]: { label: "" },
    [AppAction.run]: { label: "Run", accelerator: "CmdOrCtrl+Enter" },
    [AppAction.runSelection]: { label: "Run Selection", accelerator: "CmdOrCtrl+Shift+Enter" },
    [AppAction.stop]: { label: "Stop", accelerator: "CmdOrCtrl+." },
    [AppAction.retry]: { label: "Retry" },
    [AppAction.newTab]: { label: "New Query Tab", accelerator: "CmdOrCtrl+T" },
    [AppAction.closeTab]: { label: "Close Query Tab", accelerator: "CmdOrCtrl+W" },
    [AppAction.openFile]: { label: "Open SQL File…", accelerator: "CmdOrCtrl+O" },
    [AppAction.saveFile]: { label: "Save SQL File…", accelerator: "CmdOrCtrl+S" },
    [AppAction.exportResults]: { label: "Export Results…", accelerator: "CmdOrCtrl+E" },
    [AppAction.formatQuery]: { label: "Format Query", accelerator: "Shift+Alt+F" },
    [AppAction.find]: { label: "Find", accelerator: "CmdOrCtrl+F" },
    [AppAction.refreshCatalog]: { label: "Refresh Schema", accelerator: "F5" },
    [AppAction.connections]: { label: "Connections…", accelerator: "CmdOrCtrl+," },
    [AppAction.toggleHistory]: { label: "History", accelerator: "CmdOrCtrl+Shift+H" },
    [AppAction.toggleSaved]: { label: "Saved Queries", accelerator: "CmdOrCtrl+Shift+L" },
    [AppAction.saveQuery]: { label: "Save Query As…", accelerator: "CmdOrCtrl+Shift+S" },
    [AppAction.restartQueryHost]: { label: "Restart Query Host" },
    [AppAction.appearanceSystem]: { label: "System" },
    [AppAction.appearanceLight]: { label: "Light" },
    [AppAction.appearanceDark]: { label: "Dark" },
    [AppAction.selectRows]: { label: `Select Rows (LIMIT ${SelectRowsLimit})` },
    [AppAction.describeTable]: { label: "Describe" },
    [AppAction.copyQualifiedName]: { label: "Copy Qualified Name" },
    [AppAction.reloadOwner]: { label: "Reload Owner" },
    [AppAction.copyCell]: { label: "Copy Cell" },
    [AppAction.copyRow]: { label: "Copy Row" },
    [AppAction.copyColumn]: { label: "Copy Column" },
    [AppAction.copySelectionTsv]: { label: "Copy All Rows as TSV" },
    [AppAction.copySelectionJson]: { label: "Copy All Rows as JSON" },
    [AppAction.inspectValue]: { label: "Inspect Value" }
  }

  /**
   * The descriptor of `action`.
   *
   * @param action - The action.
   * @returns Its descriptor.
   */
  export function describe(action: AppAction): ActionDescriptor {
    return Descriptors[action]
  }

  /**
   * The accelerator of `action` as renderer text (`CmdOrCtrl` reads {@link CmdOrCtrlText}).
   *
   * @param action - The action.
   * @returns The text, or undefined when the action has no accelerator.
   */
  export function acceleratorText(action: AppAction): string {
    return describe(action)
      .accelerator?.split(AcceleratorSeparator)
      .map(part => (part === CmdOrCtrlModifier ? CmdOrCtrlText : part))
      .join(AcceleratorSeparator)
  }

  /**
   * A toolbar tooltip: the label, plus the accelerator text in parentheses when bound.
   *
   * @param action - The action.
   * @returns `Run (Ctrl/Cmd+Enter)`, or the bare label.
   */
  export function tooltip(action: AppAction): string {
    const { label } = describe(action),
      accelerator = acceleratorText(action)
    return accelerator == null ? label : `${label} (${accelerator})`
  }
}
