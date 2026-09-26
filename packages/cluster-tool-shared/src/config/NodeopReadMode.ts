/**
 * nodeop's `read-mode` values (closed set; spellings from chain_plugin's
 * option). Distinct from `WireClient.FinalityType`, which names the WRITE
 * confirmation level the harness waits for — a node's read mode is a read
 * setting, and the two are never interchangeable.
 */
export enum NodeopReadMode {
  head = "head",
  irreversible = "irreversible",
  speculative = "speculative"
}
