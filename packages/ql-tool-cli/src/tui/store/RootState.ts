import type { TuiStore } from "./Store.js"

/** The whole TUI state. */
export type RootState = ReturnType<TuiStore["getState"]>
