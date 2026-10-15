import type { ConnectionProfile } from "@wireio/ql-shared"
import { getLogger, NestedError } from "@wireio/shared"

import type { ConnectionTestResult } from "../../../common/index.js"
import type { AppThunk } from "../Store.js"

const log = getLogger(__filename)

/** Connection-test verdict text. */
export namespace ConnectionTest {
  /** Prefix of a passing test. */
  export const Passed = "Connected"
  /** Prefix of a failing test. */
  export const Failed = "Failed"
  /** Leading chain-id hex digits a passing verdict shows. */
  export const ChainIdPrefixLength = 12

  /**
   * The one-line verdict of a passing test.
   *
   * @param result - What the test learned about the node.
   * @returns `Connected: chain <id…>, head block <n>; query engine answering`.
   */
  export function passedMessage(result: ConnectionTestResult): string {
    return (
      `${Passed}: chain ${result.chainId.slice(0, ChainIdPrefixLength)}…, ` +
      `head block ${result.headBlockNum}; query engine answering`
    )
  }
}

/**
 * "Test connection": the node's `get_info`, then the query-engine probe — both
 * through the query host (the renderer never fetches). Reads no ABI and no table.
 *
 * @param profile - The (possibly unsaved) profile.
 * @returns The thunk resolving to a one-line verdict.
 */
export function testConnection(profile: ConnectionProfile): AppThunk<string> {
  return async (_dispatch, _getState, services) => {
    try {
      return ConnectionTest.passedMessage(await services.queryPort.testConnection(services.createRequestId(), profile))
    } catch (error) {
      const message = NestedError.toError(error).message
      log.warn(`testing the connection ${profile.name} failed: ${message}`, error)
      return `${ConnectionTest.Failed}: ${message}`
    }
  }
}
