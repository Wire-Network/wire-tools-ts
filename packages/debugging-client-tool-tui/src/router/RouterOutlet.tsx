import React from "react"
import { Text } from "ink"
import { useRouter } from "./RouterContext.js"

/**
 * Renders the current route's component. Placed once inside `App`'s body.
 * Returns a dim placeholder when the stack is empty (shouldn't happen in
 * normal operation; RouterProvider seeds a route).
 */
export function RouterOutlet(): React.ReactElement {
  const router = useRouter()
  if (!router.current) {
    return <Text dimColor>No active route.</Text>
  }
  const Component = router.current.route.component
  return <Component params={router.current.params} />
}
