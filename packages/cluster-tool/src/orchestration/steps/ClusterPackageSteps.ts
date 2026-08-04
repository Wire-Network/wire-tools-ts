import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"
import { match } from "ts-pattern"
import { Deferred } from "@wireio/shared"
import { ClusterPackageType } from "../../cluster/ClusterPackageType.js"
import { ClusterConfigProvider } from "../../config/ClusterConfigProvider.js"
import { NodeConfig } from "../../config/NodeConfig.js"
import { Report } from "../../report/Report.js"
import { ClusterBuildContext } from "../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../ClusterBuildStep.js"
import type { StepInput } from "../StepRunner.js"

/** The `archiver` module surface, loaded lazily (type-only static import). */
type ArchiverModule = typeof import("archiver")

let importArchiverModuleDeferred: Deferred<ArchiverModule> = null

/**
 * Load `archiver` once through a single cached accessor
 * (`dynamic-import-esm-only-deps.md`) — archiver@8 is ESM-only (`"type":
 * "module"`, no `require` condition), so a static import down-levels to
 * `require()` and throws `ERR_REQUIRE_ESM` at runtime. Cache assigned
 * SYNCHRONOUSLY so concurrent callers share the one in-flight import.
 */
function importArchiverModule(): Promise<ArchiverModule> {
  if (importArchiverModuleDeferred === null) {
    importArchiverModuleDeferred = new Deferred()
    import("archiver")
      .then(archiverModule => importArchiverModuleDeferred.resolve(archiverModule))
      .catch(error => {
        const failed = importArchiverModuleDeferred
        importArchiverModuleDeferred = null
        failed.reject(error)
      })
  }
  return importArchiverModuleDeferred.promise
}

/**
 * Steps that archive each node's config tree — the `package` command's writes.
 * ONE archive Step per node (per the orchestration model); the runner dispatches
 * on {@link ClusterPackageType} to the private per-format backend
 * ({@link ClusterPackageSteps.runPackageNode} → `packageNode<TYPE>`), so a new
 * format is one enum member + one backend and NOTHING else changes.
 */
export namespace ClusterPackageSteps {
  /** Subpath (under the cluster dir) where per-node archives are written. */
  export const PackagesSubpath = "packages"

  /** zlib compression level for ZIP archives. */
  const ZipCompressionLevel = 9

  /** Typed input for {@link planPackageNode}: which node + which archive format. */
  export interface PackageNodeInput extends StepInput {
    /** Step-input discriminator. */
    kind: "ClusterPackageSteps.PackageNodeInput"
    /** The node whose full tree is archived. */
    nodeName: string
    /** The archive format. */
    packageType: ClusterPackageType
  }

  /**
   * Plan the archive of ONE node's full config tree + the cluster genesis.
   *
   * @param actor - The report actor.
   * @param name - The step name.
   * @param description - The step description.
   * @param options - Step options.
   * @param nodeName - The node to archive.
   * @param packageType - The archive format.
   * @returns The archive step.
   */
  export function planPackageNode<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    nodeName: string,
    packageType: ClusterPackageType
  ): ClusterBuildStep<C, PackageNodeInput> {
    return ClusterBuildStep.create<C, PackageNodeInput>(
      actor,
      name,
      description,
      options,
      { kind: "ClusterPackageSteps.PackageNodeInput", nodeName, packageType },
      runPackageNode
    )
  }

  /** Named runner — archive `input.nodeName`'s tree + genesis into `<clusterPath>/packages/`. */
  export async function runPackageNode<C extends ClusterBuildContext>(
    ctx: C,
    input: PackageNodeInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const config = ctx.config,
      node = NodeConfig.plan(config).find(
        candidate => candidate.name === input.nodeName
      )
    Assert.ok(
      node != null,
      `ClusterPackageSteps: node ${input.nodeName} not found in the topology`
    )
    const packagesDir = Path.join(config.clusterPath, PackagesSubpath)
    Fs.mkdirSync(packagesDir, { recursive: true })
    const outputFile = Path.join(
      packagesDir,
      `${input.nodeName}${extensionFor(input.packageType)}`
    )
    await match(input.packageType)
      .with(ClusterPackageType.ZIP, () =>
        packageNodeZIP(
          node.nodePath,
          ClusterConfigProvider.genesisFile(config),
          outputFile
        )
      )
      .exhaustive()
  }

  /** File extension for an archive format. */
  function extensionFor(packageType: ClusterPackageType): string {
    return match(packageType)
      .with(ClusterPackageType.ZIP, () => ".zip")
      .exhaustive()
  }

  /**
   * ZIP backend — the node's FULL tree (config.ini, logging.json, data dirs)
   * under its node name, PLUS the cluster-level `genesis.json` (a node boots
   * from this archive with no replay). NEVER includes `cluster-keys.json` (it
   * lives at the cluster root, outside `nodePath`, and is never added here).
   */
  async function packageNodeZIP(
    nodePath: string,
    genesisFile: string,
    outputFile: string
  ): Promise<void> {
    const { ZipArchive } = await importArchiverModule(),
      output = Fs.createWriteStream(outputFile),
      archive = new ZipArchive({ zlib: { level: ZipCompressionLevel } }),
      done = new Deferred<void>()
    output.on("close", () => done.resolve())
    // A destination-stream write failure must reject (not hang to timeout).
    output.on("error", error => done.reject(error))
    archive.on("error", error => done.reject(error))
    archive.pipe(output)
    // Exclude runtime artifacts a handed-off archive must not carry — a stale
    // `*.pid` or any `logs/` entry (mirrors the clone step's exclusions).
    archive.directory(nodePath, Path.basename(nodePath), entry =>
      entry.name.endsWith(".pid") || /(^|[\\/])logs([\\/]|$)/.test(entry.name)
        ? false
        : entry
    )
    archive.file(genesisFile, { name: Path.basename(genesisFile) })
    await archive.finalize()
    await done.promise
  }
}
