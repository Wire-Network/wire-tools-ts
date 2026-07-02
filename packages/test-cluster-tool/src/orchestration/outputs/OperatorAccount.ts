import { OperatorType } from "@wireio/opp-typescript-models"
import type {
  EthereumKeyPair,
  SolanaKeyPair,
  WireFinalizerKeyPair,
  WireKeyPair
} from "../../types/KeyPair.js"

/**
 * One provisioned operator's identity — its WIRE account + type-appropriate key
 * set. `type` is the proto {@link OperatorType} (the SAME classification the
 * depot's `sysio.opreg` carries) and drives which keys the account holds and
 * which on-chain steps provision it. Every provisioned account (bootstrap or
 * flow) accumulates into the ONE `ClusterKeyStore` (`ctx.keyStore`), the single
 * place keys are accessed from.
 *
 * - `wire` (K1) — every operator: the WIRE account's controller key. Batch
 *   operators / underwriters get a UNIQUE generated K1 (imported into the kiod
 *   wallet so `account@active` signs); a producer carries its NODE's key —
 *   sibling producer accounts on the same node share the SAME `wire` (accurate:
 *   the node signs blocks for all of them with that one key).
 * - `bls` — producers: the node's finality key (shared with siblings likewise).
 * - `ethereum` (EM) / `solana` (ED) — OPP operators (batch / underwriter): the
 *   authex-link + outpost signing keys.
 *
 * Downstream Steps DERIVE the live ethers/web3 signing objects from these typed
 * keys via `utils/keyPairUtils` — no raw SDK handle is ever stored. `?` fields are
 * absent for types that don't use them (strictNullChecks-off: no `| null` ceremony).
 */
export interface OperatorAccount {
  readonly account: string
  readonly type: OperatorType
  readonly wire: WireKeyPair
  readonly bls?: WireFinalizerKeyPair
  readonly ethereum?: EthereumKeyPair
  readonly solana?: SolanaKeyPair
}
