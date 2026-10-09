import type { IPCChannel } from "../../../common/index.js"
import type { StoreService } from "../../services/index.js"
import type { IPCHandlers } from "../registerIPCHandlers.js"

/** The store-backed invoke channels. */
export type StoreHandlerMap = Pick<
  IPCHandlers,
  | IPCChannel.profilesList
  | IPCChannel.profilesUpsert
  | IPCChannel.profilesRemove
  | IPCChannel.profilesSetDefault
  | IPCChannel.historyList
  | IPCChannel.historyAppend
  | IPCChannel.historyClear
  | IPCChannel.savedList
  | IPCChannel.savedUpsert
  | IPCChannel.savedRemove
>

/**
 * Handlers over the shared stores (profiles, history, saved queries).
 *
 * @param stores - The store service.
 * @returns The handlers.
 */
export function createStoreHandlers(stores: StoreService): StoreHandlerMap {
  return {
    profilesList: async () => stores.profilesDocument(),
    profilesUpsert: async profile => stores.upsertProfile(profile),
    profilesRemove: async ({ name }) => stores.removeProfile(name),
    profilesSetDefault: async ({ name }) => stores.setDefaultProfile(name),
    historyList: async request => stores.listHistory(request),
    historyAppend: async entry => stores.appendHistory(entry),
    historyClear: async () => stores.clearHistory(),
    savedList: async () => stores.listSaved(),
    savedUpsert: async request => stores.saveQuery(request),
    savedRemove: async ({ name }) => stores.removeSaved(name)
  }
}
