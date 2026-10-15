import { ConnectionProfileDefaults, type ConnectionProfilesDocument } from "@wireio/ql-shared"

import { DialogOutcome, IPCChannel, type DialogResult, type QLBridge } from "@wireio/ql-tool-app/common"
import { ConnectionsActions, createWorkbenchStore, type RootState, type WorkbenchServices } from "@wireio/ql-tool-app/renderer/store"

import { ConnectionFixtures } from "./ConnectionFixtures.js"
import { ExecutionFixtures } from "./ExecutionFixtures.js"
import { FakeQueryPort } from "./FakeQueryPort.js"

/** A fake bridge whose invoke answers per channel (unset channels resolve undefined). */
export interface FakeBridge extends QLBridge {
  invoke: jest.Mock
  send: jest.Mock
  on: jest.Mock
  /** Canned answers by channel. */
  answers: Partial<Record<IPCChannel, unknown>>
}

/** Fake services + a store over them. */
export interface FakeWorkbench {
  bridge: FakeBridge
  queryPort: FakeQueryPort
  services: WorkbenchServices
  store: ReturnType<typeof createWorkbenchStore>
}

/** Test doubles for the renderer store's services. */
export namespace FakeWorkbench {
  /** The active profile of {@link createRunnable}. */
  export const RunnableProfileName = "local"
  /** The fixed clock time. */
  export const Now = new Date("2026-10-07T12:00:00.000Z")

  /**
   * A profiles document holding `names` (the first is default).
   *
   * @param names - Profile names.
   * @returns The document.
   */
  export function profilesOf(...names: string[]): ConnectionProfilesDocument {
    return {
      defaultProfile: names[0] ?? null,
      profiles: names.map(name => ({
        name,
        endpoint: ConnectionFixtures.Endpoint,
        transportTimeoutMs: ConnectionProfileDefaults.TransportTimeoutMs,
        retries: 0,
        owners: ["sample"]
      }))
    }
  }

  /**
   * A selected dialog result.
   *
   * @param filePath - Chosen file.
   * @returns The result.
   */
  export function selected(filePath: string): DialogResult {
    return { outcome: DialogOutcome.selected, filePath }
  }

  /**
   * Build fake services and a store.
   *
   * @param preloadedState - Optional initial state.
   * @returns The workbench.
   */
  export function create(preloadedState?: Partial<RootState>): FakeWorkbench {
    let counter = 0
    const answers: FakeBridge["answers"] = {},
      bridge = {
        answers,
        invoke: jest.fn(async (channel: IPCChannel) => answers[channel]),
        send: jest.fn(),
        on: jest.fn(() => () => undefined)
      } as unknown as FakeBridge,
      queryPort = FakeQueryPort.create(),
      services: WorkbenchServices = {
        bridge,
        queryPort: FakeQueryPort.asClient(queryPort),
        createRequestId: () => `req-${++counter}`,
        clock: () => Now
      }
    return { bridge, queryPort, services, store: createWorkbenchStore(services, preloadedState) }
  }

  /**
   * A workbench with an active "local" profile whose query port answers every
   * execute with a success (history and saved re-runs, which reload history).
   *
   * @returns The workbench.
   */
  export function createRunnable(): FakeWorkbench {
    const workbench = create()
    workbench.store.dispatch(ConnectionsActions.profilesLoaded(profilesOf(RunnableProfileName)))
    workbench.bridge.answers[IPCChannel.historyList] = []
    workbench.queryPort.execute.mockImplementation(async ({ requestId }) => ExecutionFixtures.success(requestId))
    return workbench
  }

  /**
   * The requests a channel was invoked with.
   *
   * @param bridge - The fake bridge.
   * @param channel - Channel.
   * @returns The requests in order.
   */
  export function requestsOf(bridge: FakeBridge, channel: IPCChannel): unknown[] {
    return bridge.invoke.mock.calls.filter(([name]) => name === channel).map(([, request]) => request)
  }
}
