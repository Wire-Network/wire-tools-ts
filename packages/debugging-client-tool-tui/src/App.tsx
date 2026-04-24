import React, { useEffect, useState } from "react"
import { Box, Text, useApp, useInput, useWindowSize } from "ink"
import { ExitConfirmModal } from "./components/modals/ExitConfirmModal.js"
import { useMultiKeyTrigger } from "./hooks/useMultiKeyTrigger.js"
import {
  ComponentProviders,
  FeatureComponentToken
} from "./providers/ComponentProviders.js"
import { RouterOutlet, useRouter } from "./router/index.js"
import { RouteRegistry } from "./router/RouteRegistry.js"
import {
  selectCluster,
  selectUI,
  setStatus,
  useAppDispatch,
  useAppSelector
} from "./store/index.js"

/**
 * Root Ink component. Renders a header + routed body + status bar. The router
 * owns which feature view is visible; App owns global hotkeys:
 *   - Shift+Tab: cycle cyclable routes (feature switching)
 *   - Esc (x1): pop one route from the stack
 *   - Esc (x2): open the exit-confirmation modal
 *   - Ctrl+C (x1): open the exit-confirmation modal
 *   - Ctrl+C (x2): immediate exit (bypasses the modal)
 */
export function App(): React.ReactElement {
  const { columns, rows } = useWindowSize(),
    { status } = useAppSelector(selectUI),
    cluster = useAppSelector(selectCluster),
    dispatch = useAppDispatch(),
    { exit } = useApp(),
    router = useRouter()

  const widgets = ComponentProviders.get(FeatureComponentToken.StatusBar),
    [exitModalOpen, setExitModalOpen] = useState(false)

  useEffect(() => {
    dispatch(setStatus(App.ReadyStatus))
  }, [dispatch])

  /** Close the modal without exiting. */
  const cancelExit = React.useCallback(() => setExitModalOpen(false), [])
  /** Finalize the exit path via Ink's `useApp().exit` so `waitUntilExit()` resolves. */
  const confirmExit = React.useCallback(() => exit(), [exit])

  // ---- Global hotkeys ----

  // Shift+Tab → cycle through cyclable routes. Not gated by the modal — switching
  // screens with the modal open would lose the exit-intent context.
  useInput((_input, key) => {
    if (exitModalOpen) return
    if (!(key.shift && key.tab)) return
    const cyclable = RouteRegistry.cyclable()
    if (cyclable.length === 0) return
    const currentPath = router.current?.route.path,
      currentIdx = cyclable.findIndex(r => r.path === currentPath),
      nextIdx = (currentIdx + 1) % cyclable.length
    router.reset(cyclable[nextIdx].path)
  })

  // Esc — single: pop; double: open exit modal.
  useMultiKeyTrigger(
    (_input, key) => key.escape && !exitModalOpen,
    {
      1: () => router.pop(),
      2: () => setExitModalOpen(true)
    }
  )

  // Ctrl+C — single: open exit modal; double: bypass and exit immediately.
  useMultiKeyTrigger(
    (_input, key) => key.ctrl && _input === "c" && !exitModalOpen,
    {
      1: () => setExitModalOpen(true),
      2: () => exit()
    }
  )

  // ---- Header helpers ----

  const cyclableRoutes = RouteRegistry.cyclable(),
    activeRoutePath = router.current?.route.path,
    routeBadges = cyclableRoutes.map(r =>
      r.path === activeRoutePath ? `[${r.name}]` : r.name
    ),
    routeList = routeBadges.length > 0 ? routeBadges.join("  ") : "none"

  // ---- Layout ----

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
          cluster: {cluster.path ?? "(none)"} | {routeList} | {status}
        </Text>
      </Box>

      {/* Body — modal takes over when active; otherwise route content renders. */}
      <Box flexDirection="column" flexGrow={1} marginTop={1}>
        {exitModalOpen ? (
          <ExitConfirmModal onConfirm={confirmExit} onCancel={cancelExit} />
        ) : (
          <RouterOutlet />
        )}
      </Box>

      {/* Status bar — contributed widgets + global hotkey legend */}
      <Box marginTop={1}>
        {widgets.map((Widget, i) => (
          <Box
            key={Widget.id}
            marginRight={i < widgets.length - 1 ? 2 : 0}
          >
            <Widget />
          </Box>
        ))}
        <Box marginLeft={widgets.length > 0 ? 2 : 0}>
          <Text dimColor>
            [Shift+Tab] next feature  [Esc] back  [Esc Esc / Ctrl+C] exit
          </Text>
        </Box>
      </Box>
    </Box>
  )
}

export namespace App {
  /** Status string written on mount to signal the app is alive. */
  export const ReadyStatus = "ready" as const
}
