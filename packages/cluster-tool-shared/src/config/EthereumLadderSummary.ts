import { z } from "zod"
import { SchemaCodec } from "../schema/index.js"

/** A contract-name → address book as wire-ethereum's deploy scripts write it. */
export const EthereumAddressBookSchema = z.record(z.string(), z.string())
export type EthereumAddressBook = z.infer<typeof EthereumAddressBookSchema>

/**
 * `ladder-summary.json` — what wire-ethereum's `deployLadder.ts` writes after
 * climbing the liqEth and outpost ladders in mainnet order on a cluster's
 * anvil: the books it wrote, the WireNodes stand-in, the salt it deployed
 * under, and the go-live rung it stopped before.
 */
export const EthereumLadderSummarySchema = z.object({
  /** The deploy owner (anvil HD index 0). */
  owner: z.string(),
  liqEthAddressFile: z.string(),
  outpostAddressFile: z.string(),
  /** The release-state file the deep freeze records the booked figure into. */
  outpostReleaseStateFile: z.string(),
  /** The `MockWireNodes` stand-in the go-live config names as `WireNodes`. */
  wireNodes: z.string(),
  /** The salt version the ladder deployed under; the go-live takes a different one. */
  saltVersion: z.string(),
  /** The first go-live step NOT run — the deep freeze. */
  stoppedBefore: z.string(),
  /** The ladder's completed step names, in the order they ran. */
  completed: z.array(z.string()),
  liqEth: EthereumAddressBookSchema,
  outpost: EthereumAddressBookSchema
})
export type EthereumLadderSummary = z.infer<typeof EthereumLadderSummarySchema>
export const EthereumLadderSummaryCodec =
  SchemaCodec.create<EthereumLadderSummary>(EthereumLadderSummarySchema)

/**
 * The outpost release state after the deep freeze
 * (`outpost_20269999.01_deep_freeze.ts`): the frozen Depositor's figures,
 * `depositorLastPoolLiqBalance` being the one the depot bootstrap is built
 * from. Later release steps add their own keys, hence the loose object.
 */
export const EthereumFreezeReleaseStateSchema = z.looseObject({
  /** `Depositor.lastPoolLiqBalance` at the freeze, in liqETH's native 18-decimal frame. */
  depositorLastPoolLiqBalance: z.string(),
  depositorTotalShares: z.string(),
  depositorIndex: z.string(),
  depositorDDay: z.boolean()
})
export type EthereumFreezeReleaseState = z.infer<
  typeof EthereumFreezeReleaseStateSchema
>
export const EthereumFreezeReleaseStateCodec =
  SchemaCodec.create<EthereumFreezeReleaseState>(
    EthereumFreezeReleaseStateSchema
  )
