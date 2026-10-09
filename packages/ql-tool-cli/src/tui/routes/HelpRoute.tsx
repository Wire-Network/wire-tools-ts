import { Box, Text } from "ink"
import { noop } from "lodash"
import { match } from "ts-pattern"

import { ResultSummary } from "@wireio/ql-shared"

import { useTuiKeys } from "../hooks/index.js"
import { KeyBindings, KeyScope, TuiAction } from "../keys/index.js"
import { HeaderBar, SchemaTreePanel } from "../panels/index.js"
import { useTuiNavigation } from "../routing/index.js"

/**
 * Every key binding (the {@link KeyBindings.Defaults} table) by scope; Esc returns.
 *
 * @returns The route element.
 */
export function HelpRoute() {
  const navigation = useTuiNavigation()
  useTuiKeys(KeyScope.global, event =>
    match(event)
      .with({ action: TuiAction.cancel }, () => navigation.pop())
      .otherwise(noop)
  )
  return (
    <Box flexDirection="column">
      <HeaderBar />
      {Object.values(KeyScope).map(scope => (
        <Box key={scope} flexDirection="column" marginTop={1}>
          <Text bold>{scope}</Text>
          {KeyBindings.Defaults.filter(binding => binding.scope === scope).map(binding => (
            <Text key={binding.action}>{`  ${KeyBindings.helpLine(binding)}`}</Text>
          ))}
        </Box>
      ))}
      <Text dimColor>{HelpRoute.KeysHint}</Text>
    </Box>
  )
}

/** Help route constants. */
export namespace HelpRoute {
  /** Key hint (chord labels from the bindings; the schema keys are the tree's own). */
  export const KeysHint = ResultSummary.join([
    `${KeyBindings.labelOf(TuiAction.cancel)} back`,
    `editor: type SQL, arrows move, ${KeyBindings.hint(KeyBindings.UndoChord, "undo")}`,
    `schema: ${SchemaTreePanel.KeysLabel}`
  ])
}
