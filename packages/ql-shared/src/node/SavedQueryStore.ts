import Crypto from "node:crypto"

import { NestedError } from "@wireio/shared"

import {
  SavedQueriesDocument,
  SavedQueriesDocumentCodec,
  type SavedQuery
} from "../profiles/index.js"
import { JsonDocumentStore, type JsonDocumentUnwatch } from "./JsonDocumentStore.js"
import { QLPaths } from "./QLPaths.js"

/** `saved-queries.json`: named queries. */
export class SavedQueryStore {
  private readonly store: JsonDocumentStore<SavedQueriesDocument>

  /**
   * @param file - The document (default {@link QLPaths.savedQueriesFile}).
   */
  constructor(readonly file: string = QLPaths.savedQueriesFile()) {
    this.store = new JsonDocumentStore({
      file,
      codec: SavedQueriesDocumentCodec,
      createEmpty: SavedQueriesDocument.empty
    })
  }

  /**
   * Every saved query.
   *
   * @returns Saved queries in saved order.
   */
  list(): SavedQuery[] {
    return this.store.read().queries
  }

  /**
   * One saved query by id.
   *
   * @param id - The stable id.
   * @returns The saved query, or undefined when no entry has that id.
   */
  getById(id: string): SavedQuery {
    return this.list().find(saved => saved.id === id)
  }

  /**
   * One saved query by name.
   *
   * @param name - The display name (unique).
   * @returns The saved query, or undefined when no entry has that name.
   */
  getByName(name: string): SavedQuery {
    return this.list().find(saved => saved.name === name)
  }

  /**
   * One saved query, resolving `idOrName` as an id FIRST and then as a name
   * (a name that equals another entry's id therefore selects that id's entry).
   *
   * @param idOrName - Id or name.
   * @returns The saved query.
   * @throws NestedError when neither resolves.
   */
  assertSavedQuery(idOrName: string): SavedQuery {
    const found = this.getById(idOrName) ?? this.getByName(idOrName)
    if (found == null) {
      throw new NestedError(`no saved query ${idOrName}`, {
        context: { idOrName, saved: this.list().map(saved => saved.name), file: this.file }
      })
    }
    return found
  }

  /**
   * Save `query` under `name` — updating the existing entry of that name, or
   * creating one. The lookup reads the document INSIDE the update, so the entry
   * resolved is the one in the document being written.
   *
   * @param name - Display name.
   * @param query - SQL text.
   * @returns The saved entry.
   */
  save(name: string, query: string): SavedQuery {
    const now = new Date().toISOString()
    let saved: SavedQuery = null
    this.store.update(document => {
      const existing = document.queries.find(entry => entry.name === name)
      saved =
        existing == null
          ? { id: Crypto.randomUUID(), name, query, createdAt: now, updatedAt: now }
          : { ...existing, query, updatedAt: now }
      return {
        queries:
          existing == null
            ? [...document.queries, saved]
            : document.queries.map(entry => (entry.id === saved.id ? saved : entry))
      }
    })
    return saved
  }

  /**
   * Remove a saved query by id or name.
   *
   * @param idOrName - Id or name.
   * @throws NestedError when absent.
   */
  remove(idOrName: string): void {
    const target = this.assertSavedQuery(idOrName)
    this.store.update(document => ({ queries: document.queries.filter(entry => entry.id !== target.id) }))
  }

  /**
   * Observe changes (including other instances' writes).
   *
   * @param listener - Receives the new document.
   * @returns Unsubscribe.
   */
  watch(listener: (document: SavedQueriesDocument) => void): JsonDocumentUnwatch {
    return this.store.watch(listener)
  }
}
