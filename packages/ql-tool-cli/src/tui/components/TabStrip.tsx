import { Box, Text } from "ink"

import { TuiColorRole, TuiPalette } from "../editor/index.js"

/** One tab. */
export interface TabStripItem<K extends string> {
  /** Tab key. */
  key: K
  /** Label. */
  label: string
}

/** Props of {@link TabStrip}. */
export interface TabStripProps<K extends string> {
  /** Tabs in order. */
  tabs: readonly TabStripItem<K>[]
  /** The active tab. */
  active: K
}

/** Gap between tab labels. */
const TabGap = 2

/**
 * A row of tab labels with the active one highlighted.
 *
 * @param props - Tabs and the active key.
 * @returns The strip element.
 */
export function TabStrip<K extends string>({ tabs, active }: TabStripProps<K>) {
  return (
    <Box columnGap={TabGap}>
      {tabs.map(tab => (
        <Text key={tab.key} bold={tab.key === active} inverse={tab.key === active} color={tab.key === active ? TuiPalette[TuiColorRole.brand] : undefined}>
          {` ${tab.label} `}
        </Text>
      ))}
    </Box>
  )
}
