import Path from "node:path"
import { PassThrough } from "node:stream"

import type { QueryEngineClientOptions, SchemaCatalogOptions } from "@wireio/ql-shared"
import { ConnectionProfileStore, QueryHistoryStore, SavedQueryStore } from "@wireio/ql-shared/node"

import { CliContext } from "@wireio/ql-tool-cli/cli/index.js"

import { createTemporaryDirectory } from "./temporaryDirectory.js"

/** Options of {@link createTestContext}. */
export interface TestContextOptions {
  /** Environment (default empty). */
  env?: NodeJS.ProcessEnv
  /** Text piped on stdin (default: a TTY stdin that is never read). */
  stdinText?: string
  /** Client overrides. */
  clientOptions?: QueryEngineClientOptions
  /** Catalog overrides. */
  catalogOptions?: SchemaCatalogOptions
}

/** A context over temp-dir stores. */
export interface TestContext {
  /** The context. */
  context: CliContext
  /** Its temp directory. */
  directory: string
}

/**
 * A CliContext whose stores live in a fresh temp directory (removed after the test file).
 *
 * @param options - Environment, stdin and overrides.
 * @returns The context and its directory.
 */
export function createTestContext(options: TestContextOptions = {}): TestContext {
  const directory = createTemporaryDirectory("wql-test-"),
    stdin = new PassThrough()
  if (options.stdinText != null) stdin.end(options.stdinText)
  return {
    directory,
    context: new CliContext({
      profileStore: new ConnectionProfileStore(Path.join(directory, "profiles.json")),
      savedQueryStore: new SavedQueryStore(Path.join(directory, "saved-queries.json")),
      historyStore: new QueryHistoryStore({ file: Path.join(directory, "history.jsonl") }),
      env: options.env ?? {},
      stdin,
      stdinIsTTY: options.stdinText == null,
      clientOptions: options.clientOptions ?? {},
      catalogOptions: options.catalogOptions ?? {}
    })
  }
}
