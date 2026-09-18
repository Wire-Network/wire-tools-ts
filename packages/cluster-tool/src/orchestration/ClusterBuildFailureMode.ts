/** Failure propagation strategy for phases and phase groups. */
export enum ClusterBuildFailureMode {
  /** Preserve the existing first-failure short circuit. */
  failFast = "failFast",
  /** Execute every independent child and report every failure. */
  collect = "collect"
}
