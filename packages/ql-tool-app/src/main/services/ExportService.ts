import Fs from "node:fs"
import Path from "node:path"

import { getLogger, NestedError } from "@wireio/shared"

import type { ExportWriteRequest, QueryFileRequest, QueryFileWriteRequest } from "../../common/index.js"

const log = getLogger(__filename)

/**
 * Writes already-rendered export text and reads/writes `.sql` files. Rendering
 * happens in the renderer (`ResultRenderer` is browser-safe); main only touches
 * the file system.
 */
export namespace ExportService {
  /** Text encoding of every file. */
  export const Encoding: BufferEncoding = "utf8"

  /**
   * Write rendered export text.
   *
   * @param request - Destination and contents.
   * @throws NestedError naming the path when the write fails.
   */
  export async function write(request: ExportWriteRequest): Promise<void> {
    await writeText(request.filePath, request.contents)
    log.info(`exported ${request.contents.length} chars to ${request.filePath}`)
  }

  /**
   * Read a `.sql` file.
   *
   * @param request - Source file.
   * @returns Its text.
   * @throws NestedError naming the path when the read fails.
   */
  export async function readQueryFile(request: QueryFileRequest): Promise<string> {
    try {
      return await Fs.promises.readFile(request.filePath, Encoding)
    } catch (error) {
      throw new NestedError(`could not read ${request.filePath}`, { cause: error, context: { file: request.filePath } })
    }
  }

  /**
   * Write a `.sql` file.
   *
   * @param request - Destination and SQL text.
   * @throws NestedError naming the path when the write fails.
   */
  export function writeQueryFile(request: QueryFileWriteRequest): Promise<void> {
    return writeText(request.filePath, request.text)
  }

  /**
   * Write text, creating the directory.
   *
   * @param file - Destination.
   * @param text - Contents.
   */
  async function writeText(file: string, text: string): Promise<void> {
    try {
      await Fs.promises.mkdir(Path.dirname(file), { recursive: true })
      await Fs.promises.writeFile(file, text, Encoding)
    } catch (error) {
      throw new NestedError(`could not write ${file}`, { cause: error, context: { file } })
    }
  }
}
