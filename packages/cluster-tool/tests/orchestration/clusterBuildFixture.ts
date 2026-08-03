import {
  ClusterBuildPhaseGroup,
  type ClusterBuildContext,
  type ClusterBuildPhaseBase
} from "@wireio/cluster-tool/orchestration"

/**
 * Every phase / group name in a built cluster tree, in registration order,
 * recursing into groups to any depth.
 *
 * Composition tests assert on this list ("`MaterializeExternalOutposts` is
 * present in external mode", "`MockReserves` is absent without the flag"), so
 * it walks the REAL orchestration nodes: `name` comes from
 * {@link ClusterBuildPhaseBase} and the recursion narrows through
 * `instanceof ClusterBuildPhaseGroup`, which is the only node kind that carries
 * `children`. Passing `cluster.children` straight in therefore needs no
 * assertion of any kind — a phase is a leaf by its type, not by a hand-declared
 * `children?` shape.
 *
 * @param children - The build's (or a group's) registered children.
 * @returns Every descendant node name, parents before their children.
 */
export function collectPhaseNames<C extends ClusterBuildContext>(
  children: ReadonlyArray<ClusterBuildPhaseBase<C>>
): string[] {
  return children.flatMap(child => [
    child.name,
    ...(child instanceof ClusterBuildPhaseGroup
      ? collectPhaseNames(child.children)
      : [])
  ])
}
