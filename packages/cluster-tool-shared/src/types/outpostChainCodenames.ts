/**
 * The depot codenames of the outpost chains — the `sysio.chains` codes the
 * registry registers, and the `chain_code` every per-chain depot row is keyed
 * by (`sysio.epoch::epochcfg` / `epochstate`, `sysio.opreg::servchains`).
 * Declared in the shared package because the persisted config schema keys each
 * outpost chain's consensus epoch duration by them; the harness's `Constants`
 * aliases them rather than re-spelling them.
 */

/**
 * One outpost chain, by its depot codename (`sysio.chains` code): each member's value is
 * the chain's `chain_code` spelling and the key of its entry in a per-chain record. A new
 * member is a new outpost chain in every record {@link mapOutpostChains} builds and every
 * per-chain schema built from it.
 */
export enum OutpostChainCodename {
  ETHEREUM = "ETHEREUM",
  SOLANA = "SOLANA"
}

/**
 * Every outpost chain codename, in outpost order (Ethereum, then Solana): the declaration
 * order of {@link OutpostChainCodename}, which every per-chain record and listing follows.
 */
export const OutpostChainCodenames: readonly OutpostChainCodename[] =
  Object.values(OutpostChainCodename)

/** One value per outpost chain, keyed by its codename. */
export type PerOutpostChain<T> = Record<OutpostChainCodename, T>

/** Separator between the chains of a {@link describeOutpostChains} fragment. */
const OutpostChainDescriptionSeparator = ", "

/**
 * One value per outpost chain: `fn` applied to every codename of
 * {@link OutpostChainCodenames}, keyed by it — the one place a per-chain record is built
 * from the chain set, so a new outpost chain reaches every such record through the compiler.
 *
 * @param fn - The value of one chain.
 * @returns The value of every outpost chain.
 */
export function mapOutpostChains<T>(
  fn: (chain: OutpostChainCodename) => T
): PerOutpostChain<T> {
  // The one cast: `Object.fromEntries` cannot see that the entries cover every codename.
  return Object.fromEntries(
    OutpostChainCodenames.map(chain => [chain, fn(chain)])
  ) as PerOutpostChain<T>
}

/**
 * Every outpost chain's value as one log fragment, in outpost order — `ETHEREUM 4, SOLANA 2`:
 * each codename followed by its chain's described value. The one formatter of a per-chain
 * record, so every log line and poll label names the chains alike.
 *
 * @param values - One value per outpost chain.
 * @param describeValue - One chain's value as text; `String` when omitted.
 * @returns The fragment.
 */
export function describeOutpostChains<T>(
  values: Readonly<PerOutpostChain<T>>,
  describeValue: (value: T, chain: OutpostChainCodename) => string = String
): string {
  return OutpostChainCodenames.map(
    chain => `${chain} ${describeValue(values[chain], chain)}`
  ).join(OutpostChainDescriptionSeparator)
}
