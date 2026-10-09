import Path from "node:path"

import { z } from "zod"

import { SchemaCodec } from "@wireio/cluster-tool-shared"
import { JsonDocumentStore } from "@wireio/ql-shared/node"
import { WindowRole } from "./WindowRole.js"

/** A window rectangle in screen coordinates. */
export const WindowBoundsSchema = z.strictObject({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive()
})

/** A window rectangle. */
export type WindowBounds = z.infer<typeof WindowBoundsSchema>

/** One window's persisted state. */
export const WindowStateSchema = z.strictObject({
  /** Last normal (un-maximized) bounds; null until first saved. */
  bounds: WindowBoundsSchema.nullable(),
  /** Whether it was maximized. */
  maximized: z.boolean()
})

/** One window's persisted state. */
export type WindowState = z.infer<typeof WindowStateSchema>

/** The persisted `window-state.json` document (keyed by {@link WindowRole}). */
export const WindowStateDocumentSchema = z.partialRecord(z.enum(WindowRole), WindowStateSchema)

/** The persisted document. */
export type WindowStateDocument = z.infer<typeof WindowStateDocumentSchema>

/** Codec for {@link WindowStateDocumentSchema}. */
export const WindowStateDocumentCodec = SchemaCodec.create<WindowStateDocument>(WindowStateDocumentSchema)

/**
 * Window bounds/maximized state in `<userData>/window-state.json`, restored on
 * relaunch; off-screen bounds are clamped onto a visible display.
 */
export class WindowStateStore {
  private readonly store: JsonDocumentStore<WindowStateDocument>

  /**
   * @param userDataPath - Electron's userData directory.
   */
  constructor(readonly userDataPath: string) {
    this.store = new JsonDocumentStore<WindowStateDocument>({
      file: Path.join(userDataPath, WindowStateStore.Filename),
      codec: WindowStateDocumentCodec,
      createEmpty: () => ({})
    })
  }

  /** The state file. */
  get file(): string {
    return this.store.config.file
  }

  /**
   * The saved state of `role` (the default when absent or the file is unreadable —
   * the store logs an unreadable file).
   *
   * @param role - Window role.
   * @returns The state.
   */
  read(role: WindowRole): WindowState {
    return this.store.readOrEmpty()[role] ?? WindowStateStore.defaultState()
  }

  /**
   * Persist the state of `role` (an unreadable file is replaced).
   *
   * @param role - Window role.
   * @param state - The state.
   */
  write(role: WindowRole, state: WindowState): void {
    this.store.write({ ...this.store.readOrEmpty(), [role]: state })
  }
}

/** Store constants + geometry helpers. */
export namespace WindowStateStore {
  /** File name inside userData. */
  export const Filename = "window-state.json"
  /** First-launch width. */
  export const DefaultWidth = 1_280
  /** First-launch height. */
  export const DefaultHeight = 820

  /**
   * The state of a never-saved window.
   *
   * @returns Unpositioned, not maximized.
   */
  export function defaultState(): WindowState {
    return { bounds: null, maximized: false }
  }

  /**
   * `bounds` when it overlaps a display's work area, else null (the window is
   * centered at the default size instead of opening off-screen).
   *
   * @param bounds - Saved bounds.
   * @param workAreas - Every display's work area.
   * @returns Visible bounds, or null.
   */
  export function visibleBounds(bounds: WindowBounds, workAreas: WindowBounds[]): WindowBounds {
    if (bounds == null) return null
    const overlaps = workAreas.some(
      area =>
        bounds.x < area.x + area.width &&
        bounds.x + bounds.width > area.x &&
        bounds.y < area.y + area.height &&
        bounds.y + bounds.height > area.y
    )
    return overlaps ? bounds : null
  }
}
