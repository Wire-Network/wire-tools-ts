import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"
import { createRequire } from "node:module"
import { DaemonConfig } from "../../config/DaemonConfig.js"
import { Report } from "../../report/Report.js"
import { mkdirs } from "../../utils/fsUtils.js"
import { ClusterBuildContext } from "../ClusterBuildContext.js"
import { ClusterBuildStep, type ClusterBuildStepOptions } from "../ClusterBuildStep.js"
import type { StepInput } from "../StepRunner.js"

/**
 * Copies the bundled debugging server into the cluster tree.
 *
 * Without it a published cluster carries an EMPTY `data/opp-debugging/` and no
 * runnable server — a consumer can see the envelope artifacts but has nothing
 * to serve them with. The bundle is fully self-contained (`external: []`), so
 * the copy plus its `start.sh` is the whole deliverable.
 */
export namespace DebuggingServerBundleSteps {
  /** Input for {@link planCopy} — carries no data; the paths derive from `ctx.config`. */
  export interface CopyInput extends StepInput {
    readonly kind: "DebuggingServerBundleSteps.CopyInput"
  }

  /** Bundle files copied into the cluster tree (the map is required by `--enable-source-maps`). */
  export const BundleFilenames: readonly string[] = [
    DaemonConfig.DebuggingServerBundleFilename,
    `${DaemonConfig.DebuggingServerBundleFilename}.map`
  ] as const

  /** Package whose `dist/bundle/` holds the built server. */
  export const BundlePackageName = "@wireio/debugging-server"

  /** Subpath of the bundle directory inside that package. */
  export const BundleSubpath = "dist/bundle"

  /**
   * Locate the built bundle directory by resolving the debugging-server
   * package, so the path holds under pnpm's symlinked workspace layout rather
   * than assuming a relative depth.
   *
   * @returns Absolute path of the bundle directory.
   */
  export function bundleDirectory(): string {
    const require = createRequire(__filename),
      packageJson = require.resolve(`${BundlePackageName}/package.json`)
    return Path.join(Path.dirname(packageJson), BundleSubpath)
  }

  /**
   * Copy the bundle into `<cluster>/data/debugging_server/`.
   *
   * ASSERTS the bundle exists rather than skipping: CI installs with a plain
   * `pnpm install`, so `prepare` → `build` produces it today — but that is
   * implicit, and one `--ignore-scripts` would otherwise ship a cluster whose
   * debugging server is silently absent.
   *
   * @param actor - The Report actor.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step options.
   * @returns The copy step.
   */
  export function planCopy<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, CopyInput> {
    return ClusterBuildStep.create<C, CopyInput>(
      actor,
      name,
      description,
      options,
      { kind: "DebuggingServerBundleSteps.CopyInput" },
      runCopy
    )
  }

  /**
   * Assert every bundle file is present in `source`.
   *
   * Separate from {@link runCopy} so the failure path is directly testable: the
   * runner resolves `source` from the installed package, which a test cannot
   * make absent without faking the module.
   *
   * @param source - The bundle directory to check.
   */
  export function assertBundlePresent(source: string): void {
    BundleFilenames.forEach(filename =>
      Assert.ok(
        Fs.existsSync(Path.join(source, filename)),
        `debugging-server bundle missing: ${Path.join(source, filename)} — build ${BundlePackageName} before creating a cluster`
      )
    )
  }

  /**
   * Copy every bundle file from `source` into `target`, creating `target`.
   *
   * @param source - The bundle directory.
   * @param target - The cluster-tree destination.
   */
  export function copyBundle(source: string, target: string): void {
    assertBundlePresent(source)
    mkdirs(target)
    BundleFilenames.forEach(filename => Fs.copyFileSync(Path.join(source, filename), Path.join(target, filename)))
  }

  /** Named runner — assert the bundle exists, then copy it into the cluster tree. */
  export async function runCopy<C extends ClusterBuildContext>(
    ctx: C,
    _input: CopyInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    copyBundle(bundleDirectory(), Path.join(ctx.config.dataPath, DaemonConfig.DebuggingServerSubpath))
  }
}
