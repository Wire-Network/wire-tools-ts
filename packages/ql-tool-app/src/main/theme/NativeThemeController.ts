import Path from "node:path"

import { z } from "zod"

import { nativeTheme } from "electron"
import { SchemaCodec } from "@wireio/cluster-tool-shared"
import { JsonDocumentStore } from "@wireio/ql-shared/node"
import { getLogger } from "@wireio/shared"

import { ThemeSource } from "../../common/index.js"

const log = getLogger(__filename)

/** The persisted `appearance.json` document. */
export const AppearanceDocumentSchema = z.strictObject({
  /** View → Appearance choice. */
  themeSource: z.enum(ThemeSource)
})

/** The persisted appearance. */
export type AppearanceDocument = z.infer<typeof AppearanceDocumentSchema>

/** Codec for {@link AppearanceDocumentSchema}. */
export const AppearanceDocumentCodec = SchemaCodec.create<AppearanceDocument>(AppearanceDocumentSchema)

/**
 * Owns `nativeTheme.themeSource` (View → Appearance System/Light/Dark), persisted
 * in `<userData>/appearance.json`. Chromium's `prefers-color-scheme` follows it,
 * so the renderer's media-query theme switches live.
 */
export class NativeThemeController {
  private readonly store: JsonDocumentStore<AppearanceDocument>

  /**
   * @param userDataPath - Electron's userData directory.
   */
  constructor(readonly userDataPath: string) {
    this.store = new JsonDocumentStore<AppearanceDocument>({
      file: Path.join(userDataPath, NativeThemeController.Filename),
      codec: AppearanceDocumentCodec,
      createEmpty: NativeThemeController.defaultDocument
    })
  }

  /** The active source. */
  get source(): ThemeSource {
    return nativeTheme.themeSource as ThemeSource
  }

  /** Apply the persisted source (system when absent or unreadable — the store logs an unreadable file). */
  restore(): void {
    nativeTheme.themeSource = this.store.readOrEmpty().themeSource
  }

  /**
   * Apply and persist a source.
   *
   * @param source - System / light / dark.
   */
  set(source: ThemeSource): void {
    nativeTheme.themeSource = source
    this.store.write({ themeSource: source })
    log.info(`appearance set to ${source}`)
  }
}

/** Controller constants. */
export namespace NativeThemeController {
  /** File name inside userData. */
  export const Filename = "appearance.json"

  /**
   * The appearance of a missing or unreadable file.
   *
   * @returns System appearance.
   */
  export function defaultDocument(): AppearanceDocument {
    return { themeSource: ThemeSource.system }
  }
}
