import Assert from "node:assert"

import { defaults } from "lodash"

import {
  EthereumReadBlockTag,
  EthereumReadConfirmationConfigSchema,
  createUnsetEthereumReadConfirmationConfig,
  type EthereumReadConfirmationConfig,
  type EthereumReadConfirmationOptions
} from "@wireio/cluster-tool-shared"

/**
 * The harness's view of `outpost_ethereum_client_plugin`'s read confirmation:
 * resolves the cluster-wide setting (`ClusterConfigProvider.resolve`) and
 * projects it onto the operator daemons' nodeop arguments. Every member stays
 * `null` — nodeop's own default — unless set; nodeop is the single author of
 * the defaults (`latest`, 12 confirmations, 1152 s).
 */
export namespace EthereumReadConfirmationConfigProvider {
  /** One read-confirmation member and the nodeop flag it renders as. */
  export interface MemberOption {
    member: keyof EthereumReadConfirmationConfig
    option: string
  }

  /**
   * Every member's nodeop flag, in the order they render. Changing an option
   * here changes the argv of every operator daemon the harness starts.
   */
  export const MemberOptions: readonly MemberOption[] = [
    { member: "blockTag", option: "--outpost-ethereum-read-block-tag" },
    { member: "confirmations", option: "--outpost-ethereum-read-confirmations" },
    {
      member: "maxFinalityLagSec",
      option: "--outpost-ethereum-read-max-finality-lag-sec"
    }
  ]

  /** The members that apply only to {@link EthereumReadBlockTag.latest}: nodeop refuses them beside another tag. */
  export const LatestOnlyMembers: readonly (keyof EthereumReadConfirmationConfig)[] =
    ["confirmations", "maxFinalityLagSec"]

  /**
   * Merge caller options over the all-unset config and validate: every SET
   * member satisfies the shared schema (a known tag, positive integers), and a
   * depth or lag is set only with no tag (nodeop's `latest`) or with `latest`.
   * An explicit `null` member stays unset, leaving nodeop's default.
   *
   * @param options - Caller options (any subset).
   * @returns The resolved config.
   */
  export function resolve(
    options: EthereumReadConfirmationOptions = {}
  ): EthereumReadConfirmationConfig {
    const config: EthereumReadConfirmationConfig = defaults(
        { ...options },
        createUnsetEthereumReadConfirmationConfig()
      ),
      parsed = EthereumReadConfirmationConfigSchema.safeParse(config)
    Assert.ok(
      parsed.success,
      `EthereumReadConfirmationConfig: ${parsed.error?.message}`
    )
    const readsLatest =
      config.blockTag == null || config.blockTag === EthereumReadBlockTag.latest
    LatestOnlyMembers.forEach(member =>
      Assert.ok(
        readsLatest || config[member] == null,
        `EthereumReadConfirmationConfig: ${optionOf(member)} applies only to the ${EthereumReadBlockTag.latest} block tag, not ${config.blockTag}`
      )
    )
    return config
  }

  /**
   * The nodeop arguments of one resolved config: a flag and its value per SET
   * member, in {@link MemberOptions} order. A `null` member emits nothing.
   *
   * @param config - The resolved read confirmation.
   * @returns The arguments (possibly empty).
   */
  export function toArgs(config: EthereumReadConfirmationConfig): string[] {
    return MemberOptions.flatMap(({ member, option }) =>
      config[member] != null ? [option, String(config[member])] : []
    )
  }

  /** The nodeop flag a member renders as, read off the one option table. */
  function optionOf(member: keyof EthereumReadConfirmationConfig): string {
    return MemberOptions.find(entry => entry.member === member).option
  }
}
