import "source-map-support/register.js"

import React from "react"
import { render } from "ink"
import { Provider } from "react-redux"

import { App } from "./App.js"
import { loadCluster, parseArgs } from "./cli.js"
import { FeatureDebugger } from "./features/FeatureDebugger.js"
import { OPPEnvelopeDebugger } from "./features/OPPEnvelope.js"
import { ProcessMonitor } from "./features/ProcessMonitor.js"
import {
  registerFeature,
  setCluster,
  store,
  type RegisteredFeature
} from "./store.js"

/**
 * TUI entry point. Parses CLI args, loads the cluster's on-disk files,
 * bootstraps core + feature debuggers (each of which contributes Panels
 * and StatusWidgets into `ComponentProviders`), and mounts the Ink tree
 * under the Redux provider.
 */
function main(): void {
  const args = parseArgs()
  const loaded = loadCluster(args.clusterPath)

  store.dispatch(
    setCluster({
      path: loaded.path,
      config: loaded.config,
      state: loaded.state
    })
  )

  const debuggers = [new ProcessMonitor(), new OPPEnvelopeDebugger()]
  debuggers.forEach(dbg => {
    FeatureDebugger.add(dbg)
    const meta: RegisteredFeature = {
      id: dbg.id,
      name: dbg.name,
      core: dbg.core
    }
    store.dispatch(registerFeature(meta))
  })

  render(
    React.createElement(Provider, {
      store,
      children: React.createElement(App)
    })
  )
}

main()
