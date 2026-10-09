import { NestedError } from "@wireio/shared"

import {
  ConnectionProfile,
  ConnectionProfilesDocument,
  ConnectionProfilesDocumentCodec,
  type ConnectionProfileInput
} from "../profiles/index.js"
import { JsonDocumentStore, type JsonDocumentUnwatch } from "./JsonDocumentStore.js"
import { QLPaths } from "./QLPaths.js"

/** `profiles.json`: saved connection profiles + the default. */
export class ConnectionProfileStore {
  private readonly store: JsonDocumentStore<ConnectionProfilesDocument>

  /**
   * @param file - The document (default {@link QLPaths.profilesFile}).
   */
  constructor(readonly file: string = QLPaths.profilesFile()) {
    this.store = new JsonDocumentStore({
      file,
      codec: ConnectionProfilesDocumentCodec,
      createEmpty: ConnectionProfilesDocument.empty
    })
  }

  /**
   * The whole document.
   *
   * @returns Profiles + default name.
   */
  read(): ConnectionProfilesDocument {
    return this.store.read()
  }

  /**
   * Every profile.
   *
   * @returns Profiles in saved order.
   */
  list(): ConnectionProfile[] {
    return this.read().profiles
  }

  /**
   * One profile, or undefined.
   *
   * @param name - Profile name.
   * @returns The profile, if saved.
   */
  get(name: string): ConnectionProfile {
    return this.list().find(profile => profile.name === name)
  }

  /**
   * One profile.
   *
   * @param name - Profile name.
   * @returns The profile.
   * @throws NestedError naming the saved profiles when absent.
   */
  assertProfile(name: string): ConnectionProfile {
    const found = this.get(name)
    if (found == null) {
      throw new NestedError(`no connection profile named ${name}`, {
        context: { name, profiles: this.list().map(profile => profile.name), file: this.file }
      })
    }
    return found
  }

  /**
   * The default profile, or undefined when none is set.
   *
   * @returns The default profile.
   */
  defaultProfile(): ConnectionProfile {
    const { defaultProfile } = this.read()
    return defaultProfile == null ? undefined : this.get(defaultProfile)
  }

  /**
   * Add or replace (by name) a profile.
   *
   * @param input - Profile fields (validated + defaulted).
   * @returns The saved profile.
   */
  upsert(input: ConnectionProfileInput): ConnectionProfile {
    const profile = ConnectionProfile.create(input)
    this.store.update(document => ({
      ...document,
      profiles: document.profiles.some(existing => existing.name === profile.name)
        ? document.profiles.map(existing => (existing.name === profile.name ? profile : existing))
        : [...document.profiles, profile]
    }))
    return profile
  }

  /**
   * Remove a profile (clearing the default when it was the default).
   *
   * @param name - Profile name.
   * @throws NestedError when absent.
   */
  remove(name: string): void {
    this.assertProfile(name)
    this.store.update(document => ({
      defaultProfile: document.defaultProfile === name ? null : document.defaultProfile,
      profiles: document.profiles.filter(profile => profile.name !== name)
    }))
  }

  /**
   * Set (or clear with null) the default profile.
   *
   * @param name - Profile name, or null.
   * @throws NestedError when the named profile is absent.
   */
  setDefault(name: string): void {
    if (name != null) this.assertProfile(name)
    this.store.update(document => ({ ...document, defaultProfile: name ?? null }))
  }

  /**
   * Observe changes (including other instances' writes).
   *
   * @param listener - Receives the new document.
   * @returns Unsubscribe.
   */
  watch(listener: (document: ConnectionProfilesDocument) => void): JsonDocumentUnwatch {
    return this.store.watch(listener)
  }
}
