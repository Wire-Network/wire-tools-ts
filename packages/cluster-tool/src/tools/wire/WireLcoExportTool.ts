import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"
import type {
  EthereumGenesisSnapshot,
  SolanaGenesisSnapshot
} from "@wireio/cluster-tool-shared"
import { ChainKind } from "@wireio/opp-typescript-models"
import type { EthereumKeyPair } from "../../types/KeyPair.js"
import { mkdirs } from "../../utils/fsUtils.js"
import { ethereumCompressedPubkey } from "../../utils/keyPairUtils.js"
import type { ImportSeedChainKind } from "./WireDclaimSeedTool.js"
import { WireLcoImportTool } from "./WireLcoImportTool.js"

/**
 * Generates the launch-data (LCO) exports a flow's bootstrap imports from committed
 * TEMPLATES: each template row names a placeholder identity, which this tool replaces with
 * the key the flow's pre-bootstrap stage (`FlowScenario.prepare`) generated and persisted —
 * a staker's address and recovered pubkey, a purchaser's address, a Solana balance's
 * address — and recomputes the Solana export's `allocationHash`, the digest the import
 * checks (`WireLcoImportTool.solanaAllocationHash`). Amounts and metadata are the
 * template's. Nothing here contacts a chain: it runs before the cluster is composed.
 *
 * Values and files only. Which identities replace which placeholders is the flow's: a
 * flow's holders (`flow-lco-import`), or its pre-funded batch operators
 * (`flow-batch-operator-prefunding`), each presented as a {@link TemplateHolder}.
 */
export namespace WireLcoExportTool {
  /** Indent of the written exports. */
  export const ExportIndent = 2
  /** Subpath, under the cluster data directory, of the exports a pre-bootstrap stage writes. */
  export const ExportsSubpath = "lco-import"
  /** Filename of the written Ethereum export. */
  export const EthereumExportFilename = "ethereum-genesis-snapshot.json"
  /** Filename of the written Solana export. */
  export const SolanaExportFilename = "solana-genesis-snapshot.json"

  /** A persisted key in the exports' display form. */
  export interface HolderIdentity {
    /** Its public key: compressed secp256k1 `0x` hex, or base58 Ed25519. */
    readonly pubkey: string
    /** Its native address: the EVM address, or the base58 key. */
    readonly address: string
  }

  /** One file per exported chain, by absolute path — the committed templates, or the written exports. */
  export interface ChainFiles {
    /** The Ethereum export (an `EthereumGenesisSnapshot`). */
    readonly ethereum: string
    /** The Solana export (a `SolanaGenesisSnapshot`). */
    readonly solana: string
  }

  /** One template placeholder and the persisted identity that replaces every row naming it. */
  export interface TemplateHolder {
    /** The chain whose template names the placeholder. */
    readonly chain: ImportSeedChainKind
    /**
     * The placeholder address the template's rows carry, in the export's display form
     * (the EVM address, or the base58 key).
     */
    readonly templateAddress: string
    /** The persisted identity written in its place. */
    readonly identity: HolderIdentity
  }

  /** The persisted identities, by the {@link templateKey} of the placeholder each replaces. */
  export type TemplateIdentities = Map<string, HolderIdentity>

  /**
   * The written exports' paths under the cluster data directory.
   *
   * @param dataPath - The cluster data directory.
   * @returns Both exports' absolute paths.
   */
  export function exportFiles(dataPath: string): ChainFiles {
    const exportsPath = Path.join(dataPath, ExportsSubpath)
    return {
      ethereum: Path.join(exportsPath, EthereumExportFilename),
      solana: Path.join(exportsPath, SolanaExportFilename)
    }
  }

  /**
   * An Ethereum key's identity: its compressed key and its address, both in the export's
   * lowercase `0x` form.
   *
   * @param pair - The persisted EM pair.
   * @returns The identity.
   */
  export function ethereumIdentity(pair: EthereumKeyPair): HolderIdentity {
    return {
      pubkey: WireLcoImportTool.evmDisplayHex(
        Buffer.from(ethereumCompressedPubkey(pair)).toString("hex")
      ),
      address: WireLcoImportTool.evmDisplayHex(pair.address)
    }
  }

  /**
   * A Solana key's identity: its base58 key, which is also its address.
   *
   * @param publicKey - The persisted keypair's base58 public key.
   * @returns The identity.
   */
  export function solanaIdentity(publicKey: string): HolderIdentity {
    return { pubkey: publicKey, address: publicKey }
  }

  /**
   * A template address in the form rows are matched by: EVM lowercase `0x`, base58 verbatim.
   *
   * @param chain - The address's chain kind.
   * @param address - The address in display form.
   * @returns The lookup key.
   */
  export function templateKey(chain: ImportSeedChainKind, address: string): string {
    return chain === ChainKind.EVM
      ? WireLcoImportTool.evmDisplayHex(address)
      : address
  }

  /**
   * The identities keyed by the placeholder each replaces — both chains in one map, since
   * an EVM key (`0x…`) and a base58 key never collide.
   *
   * @param holders - Every placeholder → identity substitution.
   * @returns The lookup map.
   */
  export function templateIdentities(
    holders: readonly TemplateHolder[]
  ): TemplateIdentities {
    return new Map(
      holders.map(holder => [
        templateKey(holder.chain, holder.templateAddress),
        holder.identity
      ])
    )
  }

  /**
   * The Ethereum export: the template with every staker's address and recovered pubkey, and
   * every purchaser's address, replaced by the persisted identity's. Amounts and metadata
   * are the template's.
   *
   * @param template - The committed template.
   * @param identities - The identities, by template address.
   * @param file - The template's path, named in any failure.
   * @returns The export.
   */
  export function createEthereumExport(
    template: EthereumGenesisSnapshot,
    identities: TemplateIdentities,
    file: string
  ): EthereumGenesisSnapshot {
    return {
      ...template,
      stakers: template.stakers.map(staker => {
        const identity = assertIdentity(
          identities,
          ChainKind.EVM,
          staker.address,
          file
        )
        return { ...staker, address: identity.address, pubkey: identity.pubkey }
      }),
      purchasers: template.purchasers.map(purchaser => ({
        ...purchaser,
        address: assertIdentity(
          identities,
          ChainKind.EVM,
          purchaser.address,
          file
        ).address
      }))
    }
  }

  /**
   * The Solana export: the template with every balance's address replaced by the persisted
   * identity's key, and its `allocationHash` recomputed over the rewritten balances.
   *
   * @param template - The committed template.
   * @param identities - The identities, by template address.
   * @param file - The template's path, named in any failure.
   * @returns The export.
   */
  export function createSolanaExport(
    template: SolanaGenesisSnapshot,
    identities: TemplateIdentities,
    file: string
  ): SolanaGenesisSnapshot {
    const rewritten: SolanaGenesisSnapshot = {
      ...template,
      balances: template.balances.map(balance => ({
        ...balance,
        address: assertIdentity(
          identities,
          ChainKind.SVM,
          balance.address,
          file
        ).address
      }))
    }
    return {
      ...rewritten,
      allocationHash: WireLcoImportTool.solanaAllocationHash(
        JSON.stringify(rewritten)
      )
    }
  }

  /**
   * Read a committed template as JSON; the bootstrap validates the export it becomes.
   *
   * @param file - The template's path.
   * @returns The parsed document.
   */
  export function readTemplate<T>(file: string): T {
    return JSON.parse(Fs.readFileSync(file, "utf-8")) as T
  }

  /**
   * Write one export, creating its directory.
   *
   * @param file - The export's path.
   * @param snapshot - The export.
   */
  export function writeExport(
    file: string,
    snapshot: EthereumGenesisSnapshot | SolanaGenesisSnapshot
  ): void {
    mkdirs(Path.dirname(file))
    Fs.writeFileSync(file, JSON.stringify(snapshot, null, ExportIndent))
  }

  /**
   * Write both exports under the cluster data directory from the committed templates, each
   * row's placeholder replaced by its holder's persisted identity, and return their paths —
   * what a scenario's `prepare` points `ethereumBootstrapJsonFile` /
   * `solanaBootstrapJsonFile` at.
   *
   * @param dataPath - The cluster data directory.
   * @param templates - The committed templates, by chain.
   * @param holders - Every placeholder → identity substitution, across both chains.
   * @returns The written exports.
   */
  export function writeExports(
    dataPath: string,
    templates: ChainFiles,
    holders: readonly TemplateHolder[]
  ): ChainFiles {
    const files = exportFiles(dataPath),
      identities = templateIdentities(holders)
    writeExport(
      files.ethereum,
      createEthereumExport(
        readTemplate(templates.ethereum),
        identities,
        templates.ethereum
      )
    )
    writeExport(
      files.solana,
      createSolanaExport(
        readTemplate(templates.solana),
        identities,
        templates.solana
      )
    )
    return files
  }

  /** The identity replacing a template row's address; a row no holder claims is refused. */
  function assertIdentity(
    identities: TemplateIdentities,
    chain: ImportSeedChainKind,
    address: string,
    file: string
  ): HolderIdentity {
    const identity = identities.get(templateKey(chain, address))
    Assert.ok(
      identity != null,
      `WireLcoExportTool: ${file} names ${address}, which no holder's template address claims`
    )
    return identity
  }
}
