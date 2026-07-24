import { KeyType, PrivateKey } from "@wireio/sdk-core"
import { Wallet } from "ethers"

/** WIRE token precision; `wire_amount` and balances are 9-decimal base units. */
export const WirePrecision = 9,
  /** Ticker for the depot's native token asset strings. */
  WireSymbol = "WIRE"

/**
 * The Ethereum address a wallet's swaps deliver to.
 *
 * Generated rather than random so the received ETH remains recoverable in
 * principle; the sweep only reclaims source-side WIRE (received ETH is the
 * accepted cost of a run), but the key is recorded so nothing is burned to an
 * unowned address.
 */
export interface LoadDestination {
  /** Checksummed 20-byte EVM address that receives swapped value. */
  readonly address: string
  /** Destination private key, recorded for optional later recovery. */
  readonly privateKey: string
}

/**
 * A generated load wallet before an on-chain WIRE account name exists.
 *
 * Account names are minted by `sysio.roa::newuser` at provision time, so key
 * material is generated first and the name is attached afterwards.
 */
export interface LoadWalletKey {
  /** Stable position in the wallet set; pairs source with destination. */
  readonly index: number
  /** K1 public key placed on the account's owner/active authority. */
  readonly publicKey: string
  /** K1 private key (WIF) used to sign this wallet's swaps and sweep. */
  readonly privateKey: string
  /** The matched Ethereum destination for this wallet's swaps. */
  readonly destination: LoadDestination
}

/** A load wallet with its provisioned on-chain WIRE account name. */
export interface LoadWallet extends LoadWalletKey {
  /** Provisioned WIRE account name that signs `swapfromwire`. */
  readonly account: string
}

/**
 * Generate `count` load wallets' key material, each with a matched destination.
 *
 * Pure client-side generation — no chain access and no privilege. The returned
 * keys are provisioned into accounts separately.
 *
 * @param count Number of wallets to generate; must be a positive integer.
 * @returns Generated wallet keys in index order.
 */
export function createLoadWalletKeys(count: number): readonly LoadWalletKey[] {
  if (!Number.isInteger(count) || count <= 0)
    throw new RangeError("load wallet count must be a positive integer")
  return Array.from({ length: count }, (_unused, index) => {
    const wireKey = PrivateKey.generate(KeyType.K1),
      destination = Wallet.createRandom()
    return {
      index,
      publicKey: wireKey.toPublic().toString(),
      privateKey: wireKey.toWif(),
      destination: {
        address: destination.address,
        privateKey: destination.privateKey
      }
    }
  })
}

/**
 * Format 9-decimal WIRE base units as a `sysio.token` asset string.
 *
 * @param baseUnits Raw 9-decimal base units.
 * @returns An asset string such as `0.100000000 WIRE`.
 */
export function formatWireAsset(baseUnits: bigint): string {
  if (baseUnits < 0n) throw new RangeError("WIRE asset amount must not be negative")
  const scale = 10n ** BigInt(WirePrecision),
    whole = baseUnits / scale,
    fraction = (baseUnits % scale).toString().padStart(WirePrecision, "0")
  return `${whole}.${fraction} ${WireSymbol}`
}
