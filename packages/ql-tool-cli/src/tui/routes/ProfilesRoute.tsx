import { useState } from "react"
import { noop } from "lodash"
import { match } from "ts-pattern"

import { ConnectionProfileForm, ResultSummary, type ConnectionProfile } from "@wireio/ql-shared"

import { ProfilesCommand } from "../../cli/index.js"
import type { TuiKeyEvent } from "../hooks/index.js"
import { KeyBindings, KeyName } from "../keys/index.js"
import { ProfileFormModal } from "../modals/index.js"
import { useTuiNavigation, type TuiNavigation } from "../routing/index.js"
import {
  TuiServiceId,
  useTuiServiceRegistry,
  type CatalogService,
  type PersistenceService,
  type QueryService,
  type TuiServiceRegistry
} from "../services/index.js"
import { ConnectionActions, MessageLevel, UiActions, useAppDispatch, useAppSelector, type TuiDispatch } from "../store/index.js"
import { ListRoute } from "./ListRoute.js"

/** What the Profiles route acts on. */
export interface ProfilesRouteDependencies {
  /** Store dispatch. */
  dispatch: TuiDispatch
  /** The services. */
  registry: TuiServiceRegistry
  /** Navigation (Enter returns). */
  navigation: TuiNavigation
  /** Open the add / edit form. */
  openEditor: (request: ProfileEditorRequest) => void
  /** The active profile's name (an edit of it reconnects). */
  activeName: string
}

/** An open add / edit form. */
export interface ProfileEditorRequest {
  /** Title line. */
  title: string
  /** The form to start from. */
  form: ConnectionProfileForm
}

/** `d` makes the selected profile the default. */
const DefaultInput = "d"
/** `x` removes the selected profile. */
const RemoveInput = "x"
/** `a` adds a profile. */
const AddInput = "a"
/** `e` edits the selected profile. */
const EditInput = "e"

/**
 * Saved connection profiles with their tuning (transport timeout, server
 * timeout, retries, owners): Enter switches the workbench to the selected one,
 * `a` adds and `e` edits a profile (the GUI connection manager's fields), `d`
 * makes it the default, `x` removes it, Esc returns.
 *
 * @returns The route element.
 */
export function ProfilesRoute() {
  const dispatch = useAppDispatch(),
    registry = useTuiServiceRegistry(),
    navigation = useTuiNavigation(),
    { profiles, cursor, defaultProfile, profile: active } = useAppSelector(state => state.connection),
    [editor, setEditor] = useState<ProfileEditorRequest>(null),
    dependencies: ProfilesRouteDependencies = { dispatch, registry, navigation, openEditor: setEditor, activeName: active?.name }
  return (
    <ListRoute
      title={ProfilesRoute.Title}
      emptyText={ProfilesRoute.EmptyText}
      keysHint={ProfilesRoute.KeysHint}
      items={profiles}
      cursor={cursor}
      itemKey={profile => profile.name}
      rowText={profile => ProfilesRoute.rowText(profile, defaultProfile, active?.name)}
      onCursorMoved={delta => dispatch(ConnectionActions.cursorMoved(delta))}
      onKey={(event, selected) => ProfilesRoute.handleKey(event, selected, dependencies)}
      isActive={editor == null}
    >
      {editor != null && (
        <ProfileFormModal
          title={editor.title}
          initial={editor.form}
          onCancel={() => setEditor(null)}
          onSubmit={profile => {
            setEditor(null)
            ProfilesRoute.saveProfile(profile, dependencies)
          }}
        />
      )}
    </ListRoute>
  )
}

/** Profiles route key handling. */
export namespace ProfilesRoute {
  /** Title. */
  export const Title = "Connection profiles (* default, > active)"
  /** Shown without profiles. */
  export const EmptyText = `no saved profiles — \`${AddInput}\` adds one (or \`wql profiles add <name> <endpoint>\`)`
  /** Key hint. */
  export const KeysHint = ListRoute.keysHint([
    KeyBindings.hint(KeyBindings.namedChord(KeyName.return), "use"),
    `${AddInput} add`,
    `${EditInput} edit`,
    `${DefaultInput} default`,
    `${RemoveInput} remove`
  ])
  /** Title of the add form. */
  export const AddTitle = "Add a connection profile"
  /** Title prefix of the edit form. */
  export const EditTitle = "Edit connection profile"
  /** Shown for an unset server timeout (the server's `query-timeout-ms` applies). */
  export const ServerDefaultText = "server default"
  /** Mark of the default profile. */
  export const DefaultMark = "*"
  /** Mark of the active profile. */
  export const ActiveMark = ">"
  /** Placeholder of an absent mark (keeps the columns aligned). */
  export const NoMark = " "

  /**
   * Messages-tab line after switching profiles.
   *
   * @param profile - The new connection.
   * @returns `connected to <name> (<endpoint>)`.
   */
  export function connectedText(profile: ConnectionProfile): string {
    return `connected to ${profile.name} (${profile.endpoint})`
  }

  /**
   * Route one keypress (Esc and ↑↓ are the list's).
   *
   * @param event - The resolved press.
   * @param selected - The profile under the cursor (undefined when none).
   * @param dependencies - What it acts on.
   */
  export function handleKey(event: TuiKeyEvent, selected: ConnectionProfile, dependencies: ProfilesRouteDependencies): void {
    const { registry, navigation, openEditor } = dependencies,
      persistence = () => registry.get<PersistenceService>(TuiServiceId.persistence)
    match(event)
      .with({ input: AddInput }, () => openEditor({ title: AddTitle, form: ConnectionProfileForm.empty() }))
      .when(() => selected == null, noop)
      .with({ input: EditInput }, () => openEditor({ title: `${EditTitle} ${selected.name}`, form: ConnectionProfileForm.of(selected) }))
      .with({ key: { return: true } }, () => {
        switchProfile(selected, dependencies)
        navigation.pop()
      })
      .with({ input: DefaultInput }, () => persistence().setDefaultProfile(selected))
      .with({ input: RemoveInput }, () => persistence().removeProfile(selected))
      .otherwise(noop)
  }

  /**
   * One profile row: default / active marks, name, endpoint and tuning.
   *
   * @param profile - The profile.
   * @param defaultName - The default profile's name.
   * @param activeName - The active profile's name.
   * @returns The row text.
   */
  export function rowText(profile: ConnectionProfile, defaultName: string, activeName: string): string {
    return ResultSummary.join([
      `${profile.name === defaultName ? DefaultMark : NoMark} ${profile.name === activeName ? ActiveMark : NoMark} ${profile.name}  ${profile.endpoint}`,
      `transport ${profile.transportTimeoutMs} ms`,
      `server ${profile.queryTimeoutMs == null ? ServerDefaultText : `${profile.queryTimeoutMs} ms`}`,
      `retries ${profile.retries}`,
      ...(profile.owners == null ? [] : [`owners ${profile.owners.join(ConnectionProfileForm.OwnerSeparator)}`])
    ])
  }

  /**
   * Save an added / edited profile through the shared store; saving the
   * active profile reconnects the workbench so the new timeouts / retries apply.
   *
   * @param profile - The validated profile.
   * @param dependencies - What it acts on.
   */
  export function saveProfile(profile: ConnectionProfile, dependencies: ProfilesRouteDependencies): void {
    const saved = dependencies.registry.get<PersistenceService>(TuiServiceId.persistence).saveProfile(profile)
    if (saved.name === dependencies.activeName) return switchProfile(saved, dependencies)
    dependencies.dispatch(UiActions.message(MessageLevel.info, ProfilesCommand.savedText(saved.name)))
  }

  /**
   * Switch the workbench to `profile` (new client and catalog).
   *
   * @param profile - The profile.
   * @param dependencies - What it acts on.
   */
  export function switchProfile(profile: ConnectionProfile, { dispatch, registry }: ProfilesRouteDependencies): void {
    dispatch(ConnectionActions.profileSelected(profile))
    registry.get<QueryService>(TuiServiceId.query).useProfile(profile)
    registry.get<CatalogService>(TuiServiceId.catalog).useProfile(profile)
    dispatch(UiActions.message(MessageLevel.info, connectedText(profile)))
  }
}
