/** Connection values shared by every suite that never dials the engine. */
export namespace ConnectionFixtures {
  /**
   * The endpoint of every fixture profile and catalog snapshot. A portless `.invalid`
   * host (RFC 6761): it never resolves, so no suite can reach a real socket through it,
   * and it claims no port outside the bind registry. Suites that do dial use the stub
   * engine's registry-issued URL instead.
   */
  export const Endpoint = "http://query-engine.invalid"
}
