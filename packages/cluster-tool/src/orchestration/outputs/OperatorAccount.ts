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
 *   `depositor`). It **does NOT exist on chain**: it is harness-side identity
 *   only — the `ClusterKeyStore` key, the SSM secret-id `{account}` segment, and
 *   the operator daemon's node-directory name. Deterministic and known at PLAN
 *   time, which is why secret ids can be rendered before any account exists. It
 *   is NOT the `sysio.roa::newuser` sponsor nonce — that is a single-use token
 *   minted per call (`utils/nonceUtils.newSponsorNonce`) and never persisted.
 * - `account` — the operator's WIRE account name ON CHAIN, and the only value
 *   that may cross a chain boundary (action payloads, authorization actors,
 *   table query keys, daemon `--*-account` argv). Batch operators and
 *   underwriters get a node-owner-sponsored GENERATED name (`wireno.<random>`,
 *   where `wireno` is a tier-1 node-owner prefix) recorded by the
 *   sponsored-creation step, which is the only writer of this field. The suffix
 *   is derived from the nonce as entropy and is therefore NOT choosable — there
 *   is no path that requests a specific name. Producers keep the deterministic
 *   `defproducer*` names, so their `account` equals their `label` from
 *   materialization onward. For an OPP operator the field is ABSENT between
 *   materialization and sponsored creation — deliberately, so a premature
 *   chain-boundary read fails loudly instead of silently passing the handle.
 * - `wire` (K1) — every operator: the WIRE account's controller key. Batch
 *   operators / underwriters get a UNIQUE generated K1 (imported into the kiod
 *   wallet so `account@active` signs); a producer carries its NODE's key —
 *   sibling producer accounts on the same node share the SAME `wire` (accurate:
 *   the node signs blocks for all of them with that one key).
 * - `wireFinalizer` — producers: the node's finality key (shared with siblings
 *   likewise).
 * - `ethereum` (EM) / `solana` (ED) — OPP operators (batch / underwriter): the
 *   authex-link + outpost signing keys.
 *
 * Downstream Steps DERIVE the live ethers/web3 signing objects from these typed
 * keys via `utils/keyPairUtils` — no raw SDK handle is ever stored. `?` fields are
 * absent for types that don't use them (strictNullChecks-off: no `| null` ceremony).
 */
export interface OperatorAccount {
  readonly label: string
  readonly account?: string
  readonly type: OperatorType
  readonly wire: WireKeyPair
  readonly wireFinalizer?: WireFinalizerKeyPair
  readonly ethereum?: EthereumKeyPair
  readonly solana?: SolanaKeyPair
}
