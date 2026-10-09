import { AndonContractSteps } from "./AndonContractSteps.js"
import { BiosContractSteps } from "./BiosContractSteps.js"
import { BondContractSteps } from "./BondContractSteps.js"
import { ChainsContractSteps } from "./ChainsContractSteps.js"
import { DclaimContractSteps } from "./DclaimContractSteps.js"
import { EpochContractSteps } from "./EpochContractSteps.js"
import { LiqContractSteps } from "./LiqContractSteps.js"
import { MsgchContractSteps } from "./MsgchContractSteps.js"
import { OpregContractSteps } from "./OpregContractSteps.js"
import { RoaContractSteps } from "./RoaContractSteps.js"
import { SwapContractSteps } from "./SwapContractSteps.js"
import { SyndContractSteps } from "./SyndContractSteps.js"
import { SystemContractSteps } from "./SystemContractSteps.js"
import { TokenContractSteps } from "./TokenContractSteps.js"
import { TokensContractSteps } from "./TokensContractSteps.js"

/**
 * Step-layer mirror of the `sysio.*` system contracts: one sub-namespace per
 * contract (short name), each exposing a factory per ABI action —
 * `Steps.contracts.sysio.<contract>.<action>(...)`, parallel to
 * `getSysioContract(SysioContractName.<contract>).actions.<action>`.
 */
export namespace SysioContractSteps {
  export import andon = AndonContractSteps
  export import bios = BiosContractSteps
  export import bond = BondContractSteps
  export import chains = ChainsContractSteps
  export import dclaim = DclaimContractSteps
  export import epoch = EpochContractSteps
  export import liq = LiqContractSteps
  export import msgch = MsgchContractSteps
  export import opreg = OpregContractSteps
  export import roa = RoaContractSteps
  export import swap = SwapContractSteps
  export import synd = SyndContractSteps
  export import system = SystemContractSteps
  export import token = TokenContractSteps
  export import tokens = TokensContractSteps
}
