import { match, P } from "ts-pattern"

import { AppAction, IPCChannel, IPCEventChannel, StoreKind, ThemeSource, type QLBridge, type Unsubscribe } from "../../common/index.js"
import type { QueryPortClient } from "../query/index.js"
import {
  formatQuery,
  loadCatalogOwners,
  loadHistory,
  loadProfiles,
  loadSaved,
  openQueryFile,
  retryQuery,
  runQuery,
  saveQueryFile,
  selectActiveEditorTab,
  stopQuery,
  UiActions,
  UiSurface,
  WorkspaceActions,
  type AppDispatch,
  type RootState
} from "../store/index.js"

/** What menu-action handling needs. */
export interface MenuActionContext {
  /** The store's dispatch. */
  dispatch: AppDispatch
  /** The store's state. */
  getState: () => RootState
  /** The preload bridge. */
  bridge: QLBridge
  /** The query port (Restart). */
  queryPort: QueryPortClient
}

/** Routes native menu actions and store-change events into the store. */
export namespace MenuActions {
  /**
   * Perform one action.
   *
   * @param context - Store, bridge and port.
   * @param action - The action.
   */
  export function perform(context: MenuActionContext, action: AppAction): void {
    const { dispatch, getState, bridge, queryPort } = context
    match(action)
      .with(AppAction.run, () => void dispatch(runQuery(false)))
      .with(AppAction.runSelection, () => void dispatch(runQuery(true)))
      .with(AppAction.stop, () => void dispatch(stopQuery()))
      .with(AppAction.retry, () => void dispatch(retryQuery()))
      .with(AppAction.newTab, () => dispatch(WorkspaceActions.tabAdded({})))
      .with(AppAction.closeTab, () => dispatch(WorkspaceActions.tabClosed(selectActiveEditorTab(getState().workspace).id)))
      .with(AppAction.openFile, () => void dispatch(openQueryFile()))
      .with(AppAction.saveFile, () => void dispatch(saveQueryFile()))
      .with(AppAction.exportResults, () => dispatch(UiActions.surfaceOpened(UiSurface.export)))
      .with(AppAction.formatQuery, () => void dispatch(formatQuery()))
      .with(AppAction.find, () => dispatch(UiActions.surfaceToggled(UiSurface.find)))
      .with(AppAction.refreshCatalog, () => void dispatch(loadCatalogOwners()))
      .with(AppAction.connections, () => dispatch(UiActions.surfaceOpened(UiSurface.connections)))
      .with(AppAction.toggleHistory, () => dispatch(UiActions.surfaceToggled(UiSurface.history)))
      .with(AppAction.toggleSaved, () => dispatch(UiActions.surfaceToggled(UiSurface.saved)))
      .with(AppAction.saveQuery, () => dispatch(UiActions.surfaceOpened(UiSurface.saveQuery)))
      .with(AppAction.restartQueryHost, () => queryPort.restart())
      .with(AppAction.appearanceSystem, () => void bridge.invoke(IPCChannel.setThemeSource, { source: ThemeSource.system }))
      .with(AppAction.appearanceLight, () => void bridge.invoke(IPCChannel.setThemeSource, { source: ThemeSource.light }))
      .with(AppAction.appearanceDark, () => void bridge.invoke(IPCChannel.setThemeSource, { source: ThemeSource.dark }))
      .with(
        P.union(
          AppAction.none,
          AppAction.selectRows,
          AppAction.describeTable,
          AppAction.copyQualifiedName,
          AppAction.reloadOwner,
          AppAction.copyCell,
          AppAction.copyRow,
          AppAction.copyColumn,
          AppAction.copySelectionTsv,
          AppAction.copySelectionJson,
          AppAction.inspectValue
        ),
        () => undefined
      )
      .exhaustive()
  }

  /**
   * Reload the store a changed file backs.
   *
   * @param dispatch - The store's dispatch.
   * @param kind - Which store changed.
   */
  export function reloadStore(dispatch: AppDispatch, kind: StoreKind): void {
    match(kind)
      .with(StoreKind.profiles, () => void dispatch(loadProfiles()))
      .with(StoreKind.history, () => void dispatch(loadHistory()))
      .with(StoreKind.saved, () => void dispatch(loadSaved()))
      .exhaustive()
  }

  /**
   * Subscribe to `menuAction` and `storeChanged`.
   *
   * @param context - Store, bridge and port.
   * @returns Unsubscribe.
   */
  export function subscribe(context: MenuActionContext): Unsubscribe {
    const unsubscribes = [
      context.bridge.on(IPCEventChannel.menuAction, action => perform(context, action)),
      context.bridge.on(IPCEventChannel.storeChanged, kind => reloadStore(context.dispatch, kind))
    ]
    return () => unsubscribes.forEach(unsubscribe => unsubscribe())
  }
}
