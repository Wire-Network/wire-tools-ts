import { OperatorType } from "@wireio/opp-typescript-models"
import type {
  EthereumKeyPair,
  SolanaKeyPair,
  WireFinalizerKeyPair,
  WireKeyPair
} from "../../types/KeyPair.js"

/**
 * One provisioned operator's identity — its durable `label`, the `account` it
 * acts as ON CHAIN, and its type-appropriate key set. `type` is the proto
 * {@link OperatorType} (the SAME classification the depot's `sysio.opreg`
 * carries) and drives which keys the account holds and which on-chain steps
 * provision it. Every provisioned operator (bootstrap or flow) accumulates into
 * the ONE `ClusterKeyStore` (`ctx.keyStore`), the single place keys are accessed
 * from, keyed by `label`.
 *
 * - `label` — the DURABLE harness handle (`batchop.a`, `uwrit.a`, a flow's
 *   `depositor`, the bios NODE's name): the `ClusterKeyStore` key, the SSM
 *   secret-id `{account}` segment (unless `publicationLabel` names the hosting
 *   node), and the operator daemon's node-directory name. Deterministic and
 *   known at PLAN time, which is why secret ids can be rendered before any
 *   account exists.
 * - `account` — the operator's WIRE account name ON CHAIN, and the only value
 *   that may cross a chain boundary (action payloads, authorization actors,
 *   table query keys, daemon `--*-account` argv). `sysio` creates every
 *   operator's account under its `label`, so the two are equal for producers,
 *   batch operators and underwriters; the bios node is the one identity whose
 *   `account` (`sysio`) differs from its `label`.
 * - `wire` (K1) — every operator: the WIRE account's controller key. Batch
 *   operators / underwriters get a UNIQUE generated K1 (imported into the kiod
 *   wallet so `account@active` signs); a producer carries its NODE's key —
 *   sibling producer accounts on the same node share the SAME `wire` (accurate:
 *   the node signs blocks for all of them with that one key).
 * - `wireFinalizer` — producers: the node's own finality key when the node hosts
 *   this producer alone; on a node hosting several, a key minted for the
 *   account (`regfinkey` enforces global finalizer-key uniqueness, so siblings
 *   never share one).
 * - `ethereum` (EM) / `solana` (ED) — OPP operators (batch / underwriter): the
 *   authex-link + outpost signing keys.
 *
 * Downstream Steps DERIVE the live ethers/web3 signing objects from these typed
 * keys via `utils/keyPairUtils` — no raw SDK handle is ever stored. `?` fields are
 * absent for types that don't use them (strictNullChecks-off: no `| null` ceremony).
 */
export interface OperatorAccount {
  readonly label: string
  /**
   * The label whose signature-provider parameter holds this identity's keys.
   *
   * Its own `label` for every identity that OWNS its keys — producers sharing
   * a node with siblings included; the hosting NODE's name for a node's sole
   * hosted producer, which signs and votes with the node's own key set. It is
   * decided at plan time (`NodeConfig.producerPublicationLabel`) and RECORDED
   * where the key set is assigned — consumers read the recorded value and never
   * re-derive it from the topology, because "which node hosts this account
   * name" and "whose key set did this account actually receive" are two
   * different questions, and a mapping that answers the first can render a
   * real-but-WRONG parameter.
   *
   * Required so a new identity cannot silently inherit a fallback: the answer
   * is known at the moment the keys are handed over, and nowhere else.
   */
  readonly publicationLabel: string
  readonly account: string
  readonly type: OperatorType
  readonly wire: WireKeyPair
  readonly wireFinalizer?: WireFinalizerKeyPair
  readonly ethereum?: EthereumKeyPair
  readonly solana?: SolanaKeyPair
}
