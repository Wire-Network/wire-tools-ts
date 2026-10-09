import { useDispatch, useSelector } from "react-redux"

import type { RootState } from "./RootState.js"
import type { AppDispatch } from "./Store.js"
import type { UiSurface } from "./ui/UiSlice.js"

/** Typed dispatch hook (never raw `useDispatch`). */
export const useAppDispatch = useDispatch.withTypes<AppDispatch>()

/** Typed selector hook (never raw `useSelector`). */
export const useAppSelector = useSelector.withTypes<RootState>()

/**
 * Whether a dialog / drawer / bar is open.
 *
 * @param surface - The surface.
 * @returns True while it is open.
 */
export function useSurface(surface: UiSurface): boolean {
  return useAppSelector(state => state.ui.open.includes(surface))
}
