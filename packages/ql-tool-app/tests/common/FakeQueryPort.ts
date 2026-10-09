import type { QueryPortClient } from "@wireio/ql-tool-app/renderer/query"
import { QueryPortStatus } from "@wireio/ql-tool-app/renderer/query"

/**
 * The ONE fake query-port client of the renderer suites: every call the
 * workbench makes (thunks: execute / describe / loadOwner / cancel; App and the
 * status bar: start / onStatus / restart) is a jest mock.
 */
export interface FakeQueryPort {
  /** Current status (tests may set it). */
  status: QueryPortStatus
  execute: jest.Mock
  describe: jest.Mock
  loadOwner: jest.Mock
  cancel: jest.Mock
  restart: jest.Mock
  onStatus: jest.Mock
  start: jest.Mock
  /** The unsubscribe `start` returned. */
  stop: jest.Mock
}

/** Construction + typing of {@link FakeQueryPort}. */
export namespace FakeQueryPort {
  /**
   * A fake port, connecting, with no-op mocks (thunks set `execute` etc. per test).
   *
   * @returns The fake.
   */
  export function create(): FakeQueryPort {
    const stop = jest.fn()
    return {
      status: QueryPortStatus.connecting,
      execute: jest.fn(),
      describe: jest.fn(),
      loadOwner: jest.fn(),
      cancel: jest.fn(),
      restart: jest.fn(),
      onStatus: jest.fn(() => () => undefined),
      start: jest.fn(() => stop),
      stop
    }
  }

  /**
   * The fake as the client type the workbench takes.
   *
   * @param port - The fake.
   * @returns The same object, typed.
   */
  export function asClient(port: FakeQueryPort): QueryPortClient {
    return port as unknown as QueryPortClient
  }
}
