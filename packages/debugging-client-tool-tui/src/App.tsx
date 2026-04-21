import React, { useEffect } from "react"
import { Box, Text, useApp, useInput, useWindowSize } from "ink"

import {
  ComponentProviders,
  Panel,
  StatusWidget
} from "./providers/ComponentProviders.js"
import {
  selectCluster,
  selectFeatures,
  selectUI,
  setActiveFeature,
  setStatus,
  useAppDispatch,
  useAppSelector
} from "./store.js"

/**
 * Root Ink component. Pulls Panels + StatusWidgets from ComponentProviders,
 * lays them out inside a single border-wrapped Box sized to the terminal,
 * and wires basic keybindings (quit + feature cycling). All feature-specific
 * UI lives in debugger-contributed components.
 */
export function App(): React.ReactElement {
  const { columns, rows } = useWindowSize()
  const { status } = useAppSelector(selectUI)
  const cluster = useAppSelector(selectCluster)
  const features = useAppSelector(selectFeatures)
  const dispatch = useAppDispatch()
  const { exit } = useApp()

  const panels = ComponentProviders.get(Panel)
  const widgets = ComponentProviders.get(StatusWidget)

  useEffect(() => {
    dispatch(setStatus(App.ReadyStatus))
  }, [dispatch])

  useInput((input, key) => {
    if (key.escape || input === App.QuitKey) {
      exit()
    } else if (input === App.CycleFeatureKey) {
      const nonCore = features.registered.filter(f => !f.core)
      if (nonCore.length === 0) return
      const currentIdx = nonCore.findIndex(f => f.id === features.activeId)
      const next = nonCore[(currentIdx + 1) % (nonCore.length + 1)] ?? null
      dispatch(setActiveFeature(next?.id ?? null))
    }
  })

  const activeFeature =
    features.registered.find(f => f.id === features.activeId)?.name ?? "none"

  return (
    <Box
      flexDirection="column"
      width={columns}
      height={rows}
      padding={1}
      borderStyle="round"
      borderColor="cyan"
    >
      {/* Header */}
      <Box flexDirection="column">
        <Text bold color="cyan">
          wire-debugging-client-tool-tui
        </Text>
        <Text dimColor>
          cluster: {cluster.path ?? "(none)"} | feature: {activeFeature} |{" "}
          {status}
        </Text>
      </Box>

      {/* Body — contributed panels stacked with their flex weights */}
      <Box flexDirection="column" flexGrow={1} marginTop={1}>
        {panels.length === 0 ? (
          <Text dimColor>No panels registered.</Text>
        ) : (
          panels.map(p => (
            <Box
              key={p.id}
              flexDirection="column"
              flexGrow={p.flex}
              borderStyle="single"
              borderColor="gray"
              paddingX={1}
            >
              <Text bold>{p.title}</Text>
              {p.render()}
            </Box>
          ))
        )}
      </Box>

      {/* Status bar — contributed widgets in a row */}
      <Box marginTop={1}>
        {widgets.map((w, i) => (
          <Box key={w.id} marginRight={i < widgets.length - 1 ? 2 : 0}>
            {w.render()}
          </Box>
        ))}
        {widgets.length > 0 && (
          <Box marginLeft={2}>
            <Text dimColor>
              [{App.CycleFeatureKey}] cycle feature [{App.QuitKey}] quit
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  )
}

export namespace App {
  /** Keybinding — quit and return to the shell. */
  export const QuitKey = "q" as const
  /** Keybinding — cycle through registered non-core feature debuggers. */
  export const CycleFeatureKey = "f" as const
  /** Status string written on mount to signal the app is alive. */
  export const ReadyStatus = "ready" as const
}
