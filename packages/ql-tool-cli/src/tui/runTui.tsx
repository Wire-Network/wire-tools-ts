import type { EventEmitter } from "node:events"

import { render, type Instance } from "ink"

import { ProcessSignalName } from "@wireio/cluster-tool-shared"
import { getLogger, NestedError, type LevelKind } from "@wireio/shared"

import { QLCli, QLExitCode, QLUsageError, type CliContext, type ConnectionOptions } from "../cli/index.js"
import { isStdoutTTY } from "../logger.js"
import { App } from "./App.js"
import { TuiLogging, type TuiLoggingOptions } from "./logging/index.js"
import {
  CatalogService,
  PersistenceService,
  QueryService,
  StoreService,
  TuiServiceRegistry
} from "./services/index.js"
import { EditorActions, createTuiStore } from "./store/index.js"

const log = getLogger(__filename)

/** What `wql tui` boots with. */
export interface RunTuiOptions {
  /** The CLI context (stores, connection resolver, client factories). */
  context: CliContext
  /** Connection flags. */
  connection: ConnectionOptions
  /** SQL that pre-fills the editor. */
  query?: string
  /** `--log-level` (the TUI log file's level). */
  logLevel?: LevelKind
  /** Logging overrides (tests point the log file at a temp dir). */
  logging?: TuiLoggingOptions
  /** Whether stdout is a terminal (default: {@link isStdoutTTY}). */
  interactive?: boolean
  /** Where termination signals arrive (default: `process`; tests inject an emitter). */
  signals?: EventEmitter
}

/**
 * The service registry of a TUI run, in dependency order.
 *
 * @param context - The CLI context.
 * @returns The registry.
 */
export function createTuiServiceRegistry(context: CliContext): TuiServiceRegistry {
  return new TuiServiceRegistry()
    .register(new StoreService())
    .register(new PersistenceService(context))
    .register(new CatalogService(context))
    .register(new QueryService(context))
}

/**
 * Boot the TUI: file-only logging FIRST (nothing may write to the terminal
 * behind Ink), the connection, the store, the services in dependency order,
 * then Ink with `exitOnCtrlC: false` (the app owns Ctrl+C; SIGTERM / SIGHUP run
 * the same quit). Whatever happens — a boot failure, a rejected Ink exit — the
 * services stop, Ink unmounts (restoring the terminal) and the CLI's stream
 * logging returns before the error is reported.
 *
 * @param options - Context, connection, prefill and logging.
 * @returns The exit code (success after a quit; the reported code after a failure).
 * @throws QLUsageError when stdout is not a terminal.
 */
export async function runTui(options: RunTuiOptions): Promise<QLExitCode> {
  const { context, connection, query, logLevel, logging = {}, interactive = isStdoutTTY(), signals = process } = options
  if (!interactive) throw new QLUsageError("wql tui needs an interactive terminal (stdout is not a TTY)")
  const installation = TuiLogging.install({ ...logging, level: logLevel ?? logging.level }),
    registry = createTuiServiceRegistry(context),
    store = createTuiStore()
  let failure: unknown = null,
    instance: Instance = null
  try {
    const profile = context.resolveProfile(connection)
    if (query != null) store.dispatch(EditorActions.textReplaced(query))
    await registry.startAll({ store, profile })
    log.info(`tui started; logging to ${installation.file}`)
    instance = render(<App store={store} registry={registry} />, { exitOnCtrlC: false })
    await RunTui.untilExit(instance, registry, signals)
  } catch (error) {
    failure = error
  } finally {
    const stopFailure = await RunTui.shutdown(registry, instance)
    failure ??= stopFailure
    await installation.restore()
  }
  return failure == null ? QLExitCode.success : QLCli.report(context, failure)
}

/** TUI lifetime helpers. */
export namespace RunTui {
  /** Signals that quit the TUI exactly like Ctrl+C. */
  export const ShutdownSignals: readonly ProcessSignalName[] = [ProcessSignalName.SIGTERM, ProcessSignalName.SIGHUP]

  /**
   * Wait for Ink to exit; meanwhile each {@link ShutdownSignals} signal runs the
   * app's quit (cancel the in-flight query, let its history append land, unmount).
   *
   * @param instance - The rendered app.
   * @param registry - The started services.
   * @param signals - Where the signals arrive.
   * @returns Resolves when Ink exits (rejects when Ink exits with an error).
   */
  export async function untilExit(instance: Instance, registry: TuiServiceRegistry, signals: EventEmitter): Promise<void> {
    const onSignal = (signal: ProcessSignalName) => {
      log.info(`${signal}: quitting`)
      void App.quit(registry, () => instance.unmount())
    }
    ShutdownSignals.forEach(signal => signals.on(signal, onSignal))
    try {
      await instance.waitUntilExit()
    } finally {
      ShutdownSignals.forEach(signal => signals.removeListener(signal, onSignal))
    }
  }

  /**
   * Stop the services and unmount Ink (idempotent: a stopped registry and an
   * unmounted instance are no-ops).
   *
   * @param registry - The services.
   * @param instance - The rendered app (null when the boot failed first).
   * @returns The stop failure, or null.
   */
  export async function shutdown(registry: TuiServiceRegistry, instance: Instance): Promise<Error> {
    instance?.unmount()
    try {
      await registry.stopAll()
      return null
    } catch (error) {
      log.error(`stopping the TUI services failed: ${NestedError.toError(error).message}`)
      return NestedError.toError(error)
    }
  }
}
