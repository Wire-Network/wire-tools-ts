import { useDispatch, useSelector, type TypedUseSelectorHook } from "react-redux"

import type { RootState } from "./RootState.js"
import type { TuiDispatch } from "./Store.js"

/** Typed dispatch of the TUI store. */
export const useAppDispatch = (): TuiDispatch => useDispatch<TuiDispatch>()
/** Typed selector of the TUI store. */
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector
