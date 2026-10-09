import { useApp } from "ink"
import { noop } from "lodash"
import { Provider } from "react-redux"
import { match } from "ts-pattern"

import { useTuiKeys } from "./hooks/index.js"
import { KeyScope, TuiAction } from "./keys/index.js"
import { HelpRoute, HistoryRoute, ProfilesRoute, SavedQueriesRoute, WorkbenchRoute } from "./routes/index.js"
import { TuiRoute, TuiRouteOutlet, TuiRouterProvider, type TuiRouteTable } from "./routing/index.js"
import {
  TuiServiceId,
  TuiServiceProvider,
  useTuiServiceRegistry,
  type QueryService,
  type TuiServiceRegistry
} from "./services/index.js"
import type { TuiStore } from "./store/index.js"

/** Props of {@link App}. */
export interface AppProps {
  /** The TUI store. */
  store: TuiStore
  /** The started services. */
  registry: TuiServiceRegistry
}

/**
 * The wql TUI: store, services and router providers around the route outlet,
 * plus the app-level Ctrl+C (the app owns it — rendered with `exitOnCtrlC: false`).
 *
 * @param props - Store and registry.
 * @returns The app element.
 */
export function App({ store, registry }: AppProps) {
  return (
    <Provider store={store}>
      <TuiServiceProvider registry={registry}>
        <TuiRouterProvider>
          <AppShell />
        </TuiRouterProvider>
      </TuiServiceProvider>
    </Provider>
  )
}

/** The route outlet + the quit key. */
function AppShell() {
  const { exit } = useApp(),
    registry = useTuiServiceRegistry()
  useTuiKeys(KeyScope.global, ({ action }) =>
    match(action)
      .with(TuiAction.quit, () => void App.quit(registry, exit))
      .otherwise(noop)
  )
  return <TuiRouteOutlet routes={App.Routes} />
}

/** App wiring. */
export namespace App {
  /** Component per route. */
  export const Routes: TuiRouteTable = {
    [TuiRoute.workbench]: WorkbenchRoute,
    [TuiRoute.profiles]: ProfilesRoute,
    [TuiRoute.history]: HistoryRoute,
    [TuiRoute.saved]: SavedQueriesRoute,
    [TuiRoute.help]: HelpRoute
  }

  /**
   * Quit: cancel any in-flight query, wait for it to settle (so its history
   * append lands), then unmount.
   *
   * @param registry - The services.
   * @param exit - Ink's exit.
   */
  export async function quit(registry: TuiServiceRegistry, exit: () => void): Promise<void> {
    const query = registry.get<QueryService>(TuiServiceId.query)
    query.cancel()
    await query.running
    exit()
  }
}
