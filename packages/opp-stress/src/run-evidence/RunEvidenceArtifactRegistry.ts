import type { RunEvidenceArtifact } from "./RunEvidenceCoreTypes.js"
import type { RunEvidenceManifest } from "./RunEvidenceManifestTypes.js"
import type { RunEvidencePublicationCoordinator } from "./RunEvidencePublicationCoordinator.js"

/** Sorted accepted-artifact state coupled to authoritative manifest commits. */
export class RunEvidenceArtifactRegistry {
  private readonly entries = new Map<string, RunEvidenceArtifact>()

  /**
   * @param coordinator Serialized manifest publisher.
   * @param updateManifest In-memory update applied only after commit success.
   */
  constructor(
    private readonly coordinator: RunEvidencePublicationCoordinator,
    private readonly updateManifest: (manifest: RunEvidenceManifest) => void
  ) {}

  /** @return Current accepted entry for a base key, or null before acceptance. */
  get(baseKey: string): RunEvidenceArtifact | null {
    return this.entries.get(baseKey) ?? null
  }

  /** @return Canonically sorted entries with an optional proposed replacement. */
  sorted(replacement?: RunEvidenceArtifact): readonly RunEvidenceArtifact[] {
    const entries = new Map(this.entries)
    if (replacement) entries.set(replacement.baseKey, replacement)
    return [...entries.values()].sort((first, second) =>
      first.baseKey < second.baseKey
        ? -1
        : first.baseKey > second.baseKey
          ? 1
          : 0
    )
  }

  /** Commit one proposed entry without advancing memory on replace failure. */
  async commit(
    entry: RunEvidenceArtifact,
    manifest: RunEvidenceManifest,
    immutableCommitted: boolean
  ): Promise<void> {
    try {
      await this.coordinator.replaceManifest(manifest)
    } catch (error) {
      if (immutableCommitted) return this.coordinator.failClosed(error)
      throw error
    }
    this.entries.set(entry.baseKey, entry)
    this.updateManifest(manifest)
  }
}
