import { BiosContractSteps } from "./BiosContractSteps.js"
import { ChainsContractSteps } from "./ChainsContractSteps.js"
import { DclaimContractSteps } from "./DclaimContractSteps.js"
import { EpochContractSteps } from "./EpochContractSteps.js"
import { MsgchContractSteps } from "./MsgchContractSteps.js"
import { OpregContractSteps } from "./OpregContractSteps.js"
import { ReservContractSteps } from "./ReservContractSteps.js"
import { RoaContractSteps } from "./RoaContractSteps.js"
import { SystemContractSteps } from "./SystemContractSteps.js"
import { TokenContractSteps } from "./TokenContractSteps.js"
import { TokensContractSteps } from "./TokensContractSteps.js"
import { UwritContractSteps } from "./UwritContractSteps.js"

/**
 * Step-layer mirror of the `sysio.*` system contracts: one sub-namespace per
 * contract (short name), each exposing a factory per ABI action —
 * `Steps.contracts.sysio.<contract>.<action>(...)`, parallel to
 * `getSysioContract(SysioContractName.<contract>).actions.<action>`.
 */
export namespace SysioContractSteps {
  export import bios = BiosContractSteps
  export import chains = ChainsContractSteps
  export import dclaim = DclaimContractSteps
  export import epoch = EpochContractSteps
  export import msgch = MsgchContractSteps
  export import opreg = OpregContractSteps
  export import reserv = ReservContractSteps
  export import roa = RoaContractSteps
  export import system = SystemContractSteps
  export import token = TokenContractSteps
  export import tokens = TokensContractSteps
  export import uwrit = UwritContractSteps
}
