/** Failure propagation strategy for phases and phase groups. */
export enum ClusterBuildFailureMode {
  /** Stop independent work after the first failed step or child. */
  failFast = "failFast",
  /** Execute every independent step or child so reports retain all evidence. */
  collect = "collect"
}
