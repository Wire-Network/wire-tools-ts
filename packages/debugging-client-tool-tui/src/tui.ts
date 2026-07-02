import "source-map-support/register.js"
import React from "react"
import { render } from "ink"
import { Provider } from "react-redux"
import { App } from "./App.js"
import { createClient, parseArgs } from "./cli.js"
import {
  LoggingManager,
  getGlobalLogger
} from "./logging/LoggingManager.js"
import {
  DebuggingClientService,
  ReduxService,
  ServiceManager,
  ServiceManagerProvider
} from "./services/index.js"
import { RouterProvider } from "./router/RouterContext.js"
import { FeatureProviderRegistry } from "./features/FeatureProviderRegistry.js"
import OPPFeatureProvider from "./features/opp/OPPFeatureProvider.js"
import ProcessMonitorFeatureProvider from "./features/process-monitor/ProcessMonitorFeatureProvider.js"
import type { FeatureProvider } from "./features/FeatureProvider.js"
import {
  registerFeature,
  setActiveFeatures,
  setCluster,
  store
} from "./store/index.js"

/**
 * Every provider known to the binary. The active subset is derived from
 * `--features` plus any provider with `isRequiredProvider: true`.
 */
const KnownProviders: readonly FeatureProvider[] = [
  ProcessMonitorFeatureProvider,
  OPPFeatureProvider
] as const

import {
  selectActiveProviders,
  warnUnknownFeatureIds
} from "./bootstrap/selectActiveProviders.js"

async function main(): Promise<void> {
  const args = parseArgs(),
    client = await createClient(args.mode)

  // The cluster slice still expects a `path` for log file paths the
  // server publishes — for local mode it's the local cluster, for
  // remote mode the server's path is opaque to the client (UI uses
  // it as an identifier only).
  const config = await client.getClusterConfig(),
    state = await client.getClusterState(),
    clusterPath = config.clusterPath

  LoggingManager.configure({
    clusterPath,
    level: args.logLevel
  })
  const log = getGlobalLogger()
  log.info(
    args.mode.kind === "local"
      ? `TUI starting (local) — cluster: ${args.mode.clusterPath}`
      : `TUI starting (remote) — server: ${args.mode.serverUrl}`
  )

  store.dispatch(
    setCluster({
      path: clusterPath,
      config,
      state
    })
  )

  ServiceManager.register(ReduxService)
  ServiceManager.get().registerInstance(new DebuggingClientService(client))

  const active = selectActiveProviders(KnownProviders, args.activeFeatureIds),
    activeIds = active.map(p => p.id)
  if (args.activeFeatureIds) warnUnknownFeatureIds(args.activeFeatureIds, activeIds)
  store.dispatch(setActiveFeatures(activeIds))
  log.info(`Active features: ${activeIds.join(", ")}`)

  active.forEach(provider => {
    FeatureProviderRegistry.add(provider)
    store.dispatch(
      registerFeature({
        id: provider.id,
        name: provider.name,
        core: provider.isRequiredProvider
      })
    )
  })

  await ServiceManager.get().boot()

  // Home route: the required ProcessMonitor feature. Always registered because
  // `isRequiredProvider: true`, so its route is always in the registry.
  const homePath = ProcessMonitorFeatureProvider.RoutePath

  const app = render(
    React.createElement(ServiceManagerProvider, {
      manager: ServiceManager.get(),
      children: React.createElement(Provider, {
        store,
        children: React.createElement(RouterProvider, {
          initialPath: homePath,
          children: React.createElement(App)
        })
      })
    })
  )

  /**
   * Normal exit: Ink's `q` → `useApp().exit()` → `waitUntilExit()` resolves
   * → we destroy services. Abnormal: signal handlers below.
   */
  const shutdown = async (sig?: NodeJS.Signals): Promise<void> => {
    try {
      await ServiceManager.get().destroy()
    } catch (e) {
      log.error("destroy failed", e)
    }
    if (sig) process.exit(sig === "SIGINT" ? 130 : 0)
  }
  process.once("SIGINT", () => void shutdown("SIGINT"))
  process.once("SIGTERM", () => void shutdown("SIGTERM"))

  await app.waitUntilExit()
  await shutdown()
}

main().catch(err => {
  // The logging manager always has a sink — the `@wireio/shared` lazy
  // ConsoleAppender before `configure()` runs, the FileAppender after — so
  // `fatal` is the sole crash sink (no `console.*`, per use-logging-framework).
  getGlobalLogger().fatal("TUI main() crashed", err)
  process.exit(1)
})
