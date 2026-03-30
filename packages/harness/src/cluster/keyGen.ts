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
import { DefaultBLSKeyPair, DefaultK1KeyPair } from "./constants"

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
 * @param buildDir - Path to the wire-sysio build directory
 * @returns NodeKeySet containing both K1 and BLS key pairs
 */
export async function generateNodeKeySet(
  buildDir: string
): Promise<NodeKeySet> {
  const clioBinary = `${buildDir}/bin/clio`
  const sysUtilBinary = `${buildDir}/bin/sys-util`

  const [k1, bls] = await Promise.all([
    generateK1Key(clioBinary),
    generateBLSKey(sysUtilBinary)
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

/** Hardcoded bios BLS key (matches TestHarness launcher.py). */
export const BIOS_BLS_KEY: BLSKeyPair = {
  publicKey: DefaultBLSKeyPair.publicKeyStr,
  privateKey: DefaultBLSKeyPair.privateKeyStr,
  proofOfPossession: DefaultBLSKeyPair.proofOfPossessionStr
  // TODO: Remove
  //"PUB_BLS_3igm9y-m3poDQL9IU-oE2E3rjKVD025aN5_Kpod8aVKjqtg4xOrP-jGtz4wLg_IFzc7gay9YghYwVgNafpxphE2xOY5gzEPa8li1rmtFfdpXguDFhNw2FpuLWSWami8WXgUo3A",
  //"PVT_BLS_3VUaSS7tIjSgYU6c8rggjQw3holItXxPbVB-ijnnKV3XTPWC",
  // "SIG_BLS_qdQ36ASsBk_pJ9efSCZmSN5OcqNX7GIxjzpREX8TBOBVpUOheRfZmCGO7jay2lIZiD2vkrODGQDCsa3lfkB2FjhmoTce1TYpMOWv-PoPO4D36Y4yjItfa0iMgouirmcG_rubUJDtgn0bHdvtroCc3HDoBHVeI994Ycs62RVJEROyTjIlTVGk3iXoAK9skkQKz3DM3wT0yevxP_O47Ul85rJWnEVAlAjCUOsirAdu0yO1362pdnnl8kjXaPqEj_EYPvrRXw"
}

/** Hardcoded bios K1 key (the standard dev key). */
export const BIOS_K1_KEY: K1KeyPair = {
  publicKey: DefaultK1KeyPair.publicKeyWIF,
  privateKey: DefaultK1KeyPair.privateKeyWIF
}
