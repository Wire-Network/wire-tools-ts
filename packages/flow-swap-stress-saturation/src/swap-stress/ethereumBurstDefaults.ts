/** Default ETH burst knobs for local stress submissions. */
export namespace EthereumBurstDefaults {
  /**
   * Explicit requestSwap gas limit for OPP queue growth during a burst.
   *
   * Anvil estimates concurrent transactions against the same pre-burst
   * state, but requestSwap gas grows as OPP pending-message state grows.
   */
  export const RequestSwapGasLimit = 8_000_000n
}
