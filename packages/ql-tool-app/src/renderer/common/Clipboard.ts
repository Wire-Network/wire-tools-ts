import { getLogger, NestedError } from "@wireio/shared"

const log = getLogger(__filename)

/** The renderer's one way to put text on the system clipboard. */
export namespace Clipboard {
  /**
   * Write `text` to the clipboard. A refused write (no permission, no focus) is
   * logged, never thrown: copying is a convenience, not a step a flow depends on.
   *
   * @param text - The text to copy.
   * @returns True once written, false when the write was refused.
   */
  export async function copy(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch (error) {
      log.warn(`clipboard write failed: ${NestedError.toError(error).message}`, error)
      return false
    }
  }
}
