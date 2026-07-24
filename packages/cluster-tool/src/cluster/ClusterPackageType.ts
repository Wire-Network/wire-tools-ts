/**
 * Archive format for the `package` command. Identity string enum (value === key)
 * — `ZIP` is the first (and today only) member; the `match().exhaustive()`
 * dispatch in `ClusterPackageSteps` forces a new backend when a member is added.
 * Packaging is deliberately NOT zip-coupled — this enum plus its per-type
 * backend IS the extension seam (`--package-type <ClusterPackageType>`).
 */
export enum ClusterPackageType {
  ZIP = "ZIP"
}
