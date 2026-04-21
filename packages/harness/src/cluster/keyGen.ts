/**
 * Key generation for WIRE cluster nodes.
 *
 * Generates K1 (secp256k1) and BLS key pairs by shelling out to:
 *   - `clio create key --k1 --to-console`
 *   - `sys-util bls create key --to-console`
 *
 * Mirrors the Python TestHarness/accounts.py `createAccountKeys()` function.
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { log } from "../logger.js"
import { DefaultBLSKeyPair, DefaultK1KeyPair } from "./constants.js"

const execFileAsync = promisify(execFile)

/** A K1 (secp256k1) key pair. */
export interface K1KeyPair {
  publicKey: string // PUB_K1_...
  privateKey: string // PVT_K1_...
}

/** A BLS key pair with proof of possession. */
export interface BLSKeyPair {
  publicKey: string // PUB_BLS_...
  privateKey: string // PVT_BLS_...
  proofOfPossession: string // SIG_BLS_...
}

/** Full key set for a node (K1 + BLS). */
export interface NodeKeySet {
  k1: K1KeyPair
  bls: BLSKeyPair
}

/**
 * Generate a K1 key pair using `clio create key --k1 --to-console`.
 *
 * @param clioBinary - Path to the clio binary
 * @returns K1KeyPair with PVT_K1_ and PUB_K1_ formatted keys
 */
export async function generateK1Key(clioBinary: string): Promise<K1KeyPair> {
  const { stdout } = await execFileAsync(
    clioBinary,
    ["create", "key", "--k1", "--to-console"],
    { timeout: 10_000 }
  )

  const privMatch = stdout.match(/Private key:\s+(PVT_K1_\S+)/)
  const pubMatch = stdout.match(/Public key:\s+(PUB_K1_\S+)/)

  if (!privMatch || !pubMatch) {
    throw new Error(`Failed to parse K1 key from clio output: ${stdout}`)
  }

  return {
    privateKey: privMatch[1],
    publicKey: pubMatch[1]
  }
}

/**
 * Generate a BLS key pair using `sys-util bls create key --to-console`.
 *
 * @param sysUtilBinary - Path to the sys-util binary
 * @returns BLSKeyPair with PVT_BLS_, PUB_BLS_, and SIG_BLS_ formatted keys
 */
export async function generateBLSKey(
  sysUtilBinary: string
): Promise<BLSKeyPair> {
  const { stdout } = await execFileAsync(
    sysUtilBinary,
    ["bls", "create", "key", "--to-console"],
    { timeout: 10_000 }
  )

  const privMatch = stdout.match(/Private key:\s+(PVT_BLS_\S+)/)
  const pubMatch = stdout.match(/Public key:\s+(PUB_BLS_\S+)/)
  const popMatch = stdout.match(/Proof of Possession:\s+(SIG_BLS_\S+)/)

  if (!privMatch || !pubMatch || !popMatch) {
    throw new Error(`Failed to parse BLS key from sys-util output: ${stdout}`)
  }

  return {
    privateKey: privMatch[1],
    publicKey: pubMatch[1],
    proofOfPossession: popMatch[1]
  }
}

/**
 * Generate a full node key set (K1 + BLS).
 *
 * @param exe - Object with `clio` and `sysUtil` binary paths
 * @returns NodeKeySet containing both K1 and BLS key pairs
 */
export async function generateNodeKeySet(exe: {
  clio: string
  sysUtil: string
}): Promise<NodeKeySet> {
  const [k1, bls] = await Promise.all([
    generateK1Key(exe.clio),
    generateBLSKey(exe.sysUtil)
  ])

  return { k1, bls }
}

/**
 * Format a K1 signature-provider spec for nodeop command line.
 * Format: `wire-<pubkey>,wire,wire,<pubkey>,KEY:<privkey>`
 */
export function formatK1SignatureProvider(keys: K1KeyPair): string {
  return `wire-${keys.publicKey},wire,wire,${keys.publicKey},KEY:${keys.privateKey}`
}

/**
 * Format a BLS signature-provider spec for nodeop command line.
 * Format: `wire-bls-<pubkey>,wire,wire_bls,<pubkey>,KEY:<privkey>`
 */
export function formatBLSSignatureProvider(keys: BLSKeyPair): string {
  return `wire-bls-${keys.publicKey},wire,wire_bls,${keys.publicKey},KEY:${keys.privateKey}`
}

/**
 * Hardcoded BLS key pair for the bios node.
 *
 * These values mirror the `DefaultBLSKeyPair` constants in `@wireio/sdk-core`
 * and are the same keys baked into the Python TestHarness launcher. They're
 * used ONLY during cluster bootstrap — real producers generate their own
 * keys via `generateAndImportKeys`. Changing the source of these values
 * without also updating the Python launcher breaks cross-tool parity.
 */
export const BIOS_BLS_KEY: BLSKeyPair = {
  publicKey: DefaultBLSKeyPair.publicKeyStr,
  privateKey: DefaultBLSKeyPair.privateKeyStr,
  proofOfPossession: DefaultBLSKeyPair.proofOfPossessionStr
}

/**
 * Hardcoded K1 key pair for the bios node. Same ownership semantics as
 * {@link BIOS_BLS_KEY} — dev-only, bootstrap-only. Never treat this key as
 * authoritative outside a test cluster.
 */
export const BIOS_K1_KEY: K1KeyPair = {
  publicKey: DefaultK1KeyPair.publicKeyWIF,
  privateKey: DefaultK1KeyPair.privateKeyWIF
}
