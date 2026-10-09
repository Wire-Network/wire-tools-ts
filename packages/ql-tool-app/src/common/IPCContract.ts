import { z } from "zod"

import { Level } from "@wireio/shared"
import type {
  ConnectionProfile,
  ConnectionProfilesDocument,
  QueryHistoryEntry,
  SavedQuery
} from "@wireio/ql-shared"

import type { AppAction } from "./AppAction.js"
import { IPCChannel } from "./IPCChannel.js"
import { IPCEventChannel } from "./IPCEventChannel.js"
import type { ThemeSource } from "./ThemeSource.js"

/** One invoke endpoint's request/response pair. */
export interface IPCEndpoint<RequestType, ResponseType> {
  /** What the renderer sends. */
  request: RequestType
  /** What main answers. */
  response: ResponseType
}

/** Native open dialog request. */
export interface OpenDialogRequest {
  /** Dialog title. */
  title: string
  /** Accepted file extensions (without the dot). */
  extensions: string[]
}

/** Native save dialog request. */
export interface SaveDialogRequest {
  /** Dialog title. */
  title: string
  /** Suggested file name. */
  defaultName: string
  /** Accepted file extensions (without the dot). */
  extensions: string[]
}

/** One native context menu item. */
export interface ContextMenuItem {
  /** The action chosen when this item is clicked. */
  action: AppAction
  /** Item label. */
  label: string
  /** Whether the item can be clicked. */
  enabled: boolean
}

/** Native context menu request. */
export interface ContextMenuRequest {
  /** Items in display order. */
  items: ContextMenuItem[]
}

/** Appearance change. */
export interface ThemeSourceRequest {
  /** The new appearance source. */
  source: ThemeSource
}

/** Native dialog outcome (identity enum — no empty-string sentinel). */
export enum DialogOutcome {
  selected = "selected",
  cancelled = "cancelled"
}

/** The user chose a file. */
export interface DialogSelected {
  /** Discriminator. */
  outcome: DialogOutcome.selected
  /** Absolute path of the chosen file. */
  filePath: string
}

/** The user dismissed the dialog — no path at all. */
export interface DialogCancelled {
  /** Discriminator. */
  outcome: DialogOutcome.cancelled
}

/** Native dialog result, discriminated on `outcome`. */
export type DialogResult = DialogSelected | DialogCancelled

/** Write already-rendered export text (the renderer renders with ResultRenderer; main only writes). */
export interface ExportWriteRequest {
  /** Destination file. */
  filePath: string
  /** Rendered text. */
  contents: string
}

/** Read a `.sql` file chosen through a native dialog. */
export interface QueryFileRequest {
  /** Source file. */
  filePath: string
}

/** Write a `.sql` file. */
export interface QueryFileWriteRequest {
  /** Destination file. */
  filePath: string
  /** SQL text. */
  text: string
}

/** History listing filter. */
export interface HistoryListRequest {
  /** Newest-first entry cap. */
  limit: number
  /** Case-insensitive substring over the SQL text ("" = all). */
  search: string
}

/** Remove/select by name or id. */
export interface NamedRequest {
  /** Profile name, or saved-query id or name. */
  name: string
}

/** Save the editor text under a name (the store assigns id and times). */
export interface SaveQueryRequest {
  /** Display name (saving an existing name updates it). */
  name: SavedQuery["name"]
  /** SQL text. */
  query: SavedQuery["query"]
}

/** A serializable log record forwarded from renderer/preload (category comes from the sender's `getLogger(__filename)`). */
export const LogRecordPayloadSchema = z.strictObject({
  /** Logger category. */
  category: z.string().min(1),
  /** Level. */
  level: z.enum(Level),
  /** Formatted message. */
  message: z.string(),
  /** Epoch milliseconds. */
  timestamp: z.number()
})

/** A forwarded log record. */
export type LogRecordPayload = z.infer<typeof LogRecordPayloadSchema>

/** Which store changed (identity enum). */
export enum StoreKind {
  profiles = "profiles",
  history = "history",
  saved = "saved"
}

/** Every invoke channel's contract (domain types come from @wireio/ql-shared). */
export interface IPCInvokeContract {
  [IPCChannel.showOpenDialog]: IPCEndpoint<OpenDialogRequest, DialogResult>
  [IPCChannel.showSaveDialog]: IPCEndpoint<SaveDialogRequest, DialogResult>
  /** Resolves `AppAction.none` when dismissed. */
  [IPCChannel.showContextMenu]: IPCEndpoint<ContextMenuRequest, AppAction>
  [IPCChannel.setThemeSource]: IPCEndpoint<ThemeSourceRequest, void>
  [IPCChannel.profilesList]: IPCEndpoint<void, ConnectionProfilesDocument>
  [IPCChannel.profilesUpsert]: IPCEndpoint<ConnectionProfile, ConnectionProfilesDocument>
  [IPCChannel.profilesRemove]: IPCEndpoint<NamedRequest, ConnectionProfilesDocument>
  [IPCChannel.profilesSetDefault]: IPCEndpoint<NamedRequest, ConnectionProfilesDocument>
  [IPCChannel.historyList]: IPCEndpoint<HistoryListRequest, QueryHistoryEntry[]>
  [IPCChannel.historyAppend]: IPCEndpoint<QueryHistoryEntry, void>
  [IPCChannel.historyClear]: IPCEndpoint<void, void>
  [IPCChannel.savedList]: IPCEndpoint<void, SavedQuery[]>
  [IPCChannel.savedUpsert]: IPCEndpoint<SaveQueryRequest, SavedQuery[]>
  [IPCChannel.savedRemove]: IPCEndpoint<NamedRequest, SavedQuery[]>
  [IPCChannel.exportWrite]: IPCEndpoint<ExportWriteRequest, void>
  [IPCChannel.readQueryFile]: IPCEndpoint<QueryFileRequest, string>
  [IPCChannel.writeQueryFile]: IPCEndpoint<QueryFileWriteRequest, void>
}

/** Channels that are fire-and-forget sends (no response). */
export interface IPCSendContract {
  [IPCChannel.log]: LogRecordPayload
  [IPCChannel.requestQueryPort]: void
  [IPCChannel.restartQueryHost]: void
}

/** Payloads of main → renderer events. */
export interface IPCEventContract {
  [IPCEventChannel.menuAction]: AppAction
  [IPCEventChannel.queryPort]: void
  [IPCEventChannel.queryHostExited]: void
  [IPCEventChannel.queryHostFailed]: void
  [IPCEventChannel.storeChanged]: StoreKind
}

/** Invoke channel names. */
export type IPCInvokeChannel = keyof IPCInvokeContract

/** Send channel names. */
export type IPCSendChannel = keyof IPCSendContract

/** Runtime channel partition (asserted complete by the contract test). */
export namespace IPCContract {
  /** Channels answered by `ipcMain.handle`. */
  export const InvokeChannels: readonly IPCInvokeChannel[] = [
    IPCChannel.showOpenDialog,
    IPCChannel.showSaveDialog,
    IPCChannel.showContextMenu,
    IPCChannel.setThemeSource,
    IPCChannel.profilesList,
    IPCChannel.profilesUpsert,
    IPCChannel.profilesRemove,
    IPCChannel.profilesSetDefault,
    IPCChannel.historyList,
    IPCChannel.historyAppend,
    IPCChannel.historyClear,
    IPCChannel.savedList,
    IPCChannel.savedUpsert,
    IPCChannel.savedRemove,
    IPCChannel.exportWrite,
    IPCChannel.readQueryFile,
    IPCChannel.writeQueryFile
  ] as const

  /** Channels received with `ipcMain.on`. */
  export const SendChannels: readonly IPCSendChannel[] = [
    IPCChannel.log,
    IPCChannel.requestQueryPort,
    IPCChannel.restartQueryHost
  ] as const

  /**
   * Whether `channel` is an invoke channel.
   *
   * @param channel - Any channel name.
   * @returns True for invoke channels.
   */
  export function isInvokeChannel(channel: string): channel is IPCInvokeChannel {
    return (InvokeChannels as readonly string[]).includes(channel)
  }

  /**
   * Whether `channel` is a send channel.
   *
   * @param channel - Any channel name.
   * @returns True for send channels.
   */
  export function isSendChannel(channel: string): channel is IPCSendChannel {
    return (SendChannels as readonly string[]).includes(channel)
  }

  /**
   * Whether `channel` is a main → renderer event channel.
   *
   * @param channel - Any channel name.
   * @returns True for event channels.
   */
  export function isEventChannel(channel: string): channel is IPCEventChannel {
    return (Object.values(IPCEventChannel) as string[]).includes(channel)
  }
}
