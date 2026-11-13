import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { Keypair } from "@solana/web3.js"
import {
  EthereumGenesisSnapshotSchemaCodec,
  SolanaGenesisSnapshotSchemaCodec
} from "@wireio/cluster-tool-shared"
import { ChainKind } from "@wireio/opp-typescript-models"
import { ethers } from "ethers"
import {
  WireLcoExportTool,
  WireLcoImportTool
} from "@wireio/cluster-tool/tools/wire"
import { ethereumKeyPairFromWallet } from "@wireio/cluster-tool/utils"
import {
  PurchaserAddress,
  SecondStakerAddress,
  SolanaPurchaserAddress,
  SolanaStakerAddress,
  StakerAddress,
  UnstakedAddress,
  ethereumSnapshot,
  solanaSnapshot
} from "./lcoImportFixture.js"

/** A random EM identity, as a flow's persisted wallet presents it. */
function ethereumIdentity(): WireLcoExportTool.HolderIdentity {
  return WireLcoExportTool.ethereumIdentity(
    ethereumKeyPairFromWallet(ethers.Wallet.createRandom())
  )
}

/** A random ED identity, as a flow's persisted keypair presents it. */
function solanaIdentity(): WireLcoExportTool.HolderIdentity {
  return WireLcoExportTool.solanaIdentity(Keypair.generate().publicKey.toBase58())
}

/** One substitution per placeholder the fixture exports name, across both chains. */
function fixtureHolders(): WireLcoExportTool.TemplateHolder[] {
  return [
    ...[StakerAddress, SecondStakerAddress, UnstakedAddress, PurchaserAddress].map(
      templateAddress => ({
        chain: ChainKind.EVM as const,
        templateAddress,
        identity: ethereumIdentity()
      })
    ),
    ...[SolanaStakerAddress, SolanaPurchaserAddress].map(templateAddress => ({
      chain: ChainKind.SVM as const,
      templateAddress,
      identity: solanaIdentity()
    }))
  ]
}

/** The fixture exports written as the committed templates a flow ships. */
function writeTemplates(directory: string): WireLcoExportTool.ChainFiles {
  const templates = {
    ethereum: Path.join(directory, "ethereum-template.json"),
    solana: Path.join(directory, "solana-template.json")
  }
  Fs.writeFileSync(templates.ethereum, JSON.stringify(ethereumSnapshot()))
  Fs.writeFileSync(templates.solana, JSON.stringify(solanaSnapshot()))
  return templates
}

describe("WireLcoExportTool", () => {
  let directory: string

  beforeEach(() => {
    directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), "lco-export-"))
  })

  afterEach(() => {
    Fs.rmSync(directory, { recursive: true, force: true })
  })

  describe("identities and keys", () => {
    it("exportFiles places both exports under <dataPath>/lco-import/", () => {
      expect(WireLcoExportTool.exportFiles(directory)).toEqual({
        ethereum: Path.join(
          directory,
          WireLcoExportTool.ExportsSubpath,
          WireLcoExportTool.EthereumExportFilename
        ),
        solana: Path.join(
          directory,
          WireLcoExportTool.ExportsSubpath,
          WireLcoExportTool.SolanaExportFilename
        )
      })
    })

    it("ethereumIdentity renders the compressed key and the address in lowercase 0x form, and they agree", () => {
      const pair = ethereumKeyPairFromWallet(ethers.Wallet.createRandom()),
        identity = WireLcoExportTool.ethereumIdentity(pair)
      expect(identity.pubkey).toMatch(/^0x0[23][0-9a-f]{64}$/)
      expect(identity.address).toBe(pair.address.toLowerCase())
      expect(ethers.computeAddress(identity.pubkey).toLowerCase()).toBe(
        identity.address
      )
    })

    it("solanaIdentity is the base58 key as both pubkey and address", () => {
      const key = Keypair.generate().publicKey.toBase58()
      expect(WireLcoExportTool.solanaIdentity(key)).toEqual({
        pubkey: key,
        address: key
      })
    })

    it("templateKey lowercases an EVM address and keeps a base58 key verbatim", () => {
      expect(
        WireLcoExportTool.templateKey(ChainKind.EVM, StakerAddress.toUpperCase())
      ).toBe(StakerAddress)
      expect(
        WireLcoExportTool.templateKey(ChainKind.EVM, StakerAddress.slice(2))
      ).toBe(StakerAddress)
      expect(
        WireLcoExportTool.templateKey(ChainKind.SVM, SolanaStakerAddress)
      ).toBe(SolanaStakerAddress)
    })

    it("templateIdentities keys every holder by its chain's template key", () => {
      const holders = fixtureHolders(),
        identities = WireLcoExportTool.templateIdentities(holders)
      expect(identities.size).toBe(holders.length)
      holders.forEach(holder =>
        expect(
          identities.get(
            WireLcoExportTool.templateKey(holder.chain, holder.templateAddress)
          )
        ).toBe(holder.identity)
      )
    })
  })

  describe("createEthereumExport", () => {
    it("replaces every staker's address + pubkey and every purchaser's address, keeping the amounts", () => {
      const holders = fixtureHolders(),
        identities = WireLcoExportTool.templateIdentities(holders),
        template = ethereumSnapshot(),
        rewritten = WireLcoExportTool.createEthereumExport(
          template,
          identities,
          "ethereum-template.json"
        ),
        identityOf = (address: string) =>
          identities.get(WireLcoExportTool.templateKey(ChainKind.EVM, address))
      rewritten.stakers.forEach((staker, index) => {
        const original = template.stakers[index]
        expect(staker.address).toBe(identityOf(original.address).address)
        expect(staker.pubkey).toBe(identityOf(original.address).pubkey)
        expect(staker.netPrincipal).toBe(original.netPrincipal)
        expect(staker.pretokenYield).toBe(original.pretokenYield)
      })
      rewritten.purchasers.forEach((purchaser, index) => {
        const original = template.purchasers[index]
        expect(purchaser.address).toBe(identityOf(original.address).address)
        expect(purchaser.totalPretokens).toBe(original.totalPretokens)
      })
      expect(rewritten.metadata).toEqual(template.metadata)
      // The template is not mutated.
      expect(template.stakers[0].address).toBe(StakerAddress)
    })

    it("refuses a template row no holder claims, naming the template", () => {
      const holders = fixtureHolders().filter(
        holder => holder.templateAddress !== PurchaserAddress
      )
      expect(() =>
        WireLcoExportTool.createEthereumExport(
          ethereumSnapshot(),
          WireLcoExportTool.templateIdentities(holders),
          "ethereum-template.json"
        )
      ).toThrow(
        /ethereum-template\.json names 0x2222222222222222222222222222222222222222, which no holder's template address claims/
      )
    })
  })

  describe("createSolanaExport", () => {
    it("replaces every balance's address and recomputes the allocationHash over the rewritten balances", () => {
      const holders = fixtureHolders(),
        identities = WireLcoExportTool.templateIdentities(holders),
        template = solanaSnapshot(),
        rewritten = WireLcoExportTool.createSolanaExport(
          template,
          identities,
          "solana-template.json"
        )
      rewritten.balances.forEach((balance, index) => {
        const original = template.balances[index]
        expect(balance.address).toBe(
          identities.get(
            WireLcoExportTool.templateKey(ChainKind.SVM, original.address)
          ).address
        )
        expect(balance.syndicatedLiqsol).toBe(original.syndicatedLiqsol)
      })
      expect(rewritten.allocationHash).not.toBe(template.allocationHash)
      expect(rewritten.allocationHash).toBe(
        WireLcoImportTool.solanaAllocationHash(JSON.stringify(rewritten))
      )
      expect(rewritten.accounting).toEqual(template.accounting)
    })

    it("refuses a template row no holder claims, naming the template", () => {
      const holders = fixtureHolders().filter(
        holder => holder.templateAddress !== SolanaPurchaserAddress
      )
      expect(() =>
        WireLcoExportTool.createSolanaExport(
          solanaSnapshot(),
          WireLcoExportTool.templateIdentities(holders),
          "solana-template.json"
        )
      ).toThrow(
        new RegExp(
          `solana-template\\.json names ${SolanaPurchaserAddress}, which no holder's template address claims`
        )
      )
    })
  })

  describe("writeExports", () => {
    it("writes both exports under the data directory, valid for the import, naming the holders' keys", () => {
      const dataPath = Path.join(directory, "data"),
        holders = fixtureHolders(),
        files = WireLcoExportTool.writeExports(
          dataPath,
          writeTemplates(directory),
          holders
        )
      expect(files).toEqual(WireLcoExportTool.exportFiles(dataPath))
      const ethereum = EthereumGenesisSnapshotSchemaCodec.deserialize(
          Fs.readFileSync(files.ethereum, "utf8")
        ),
        solana = SolanaGenesisSnapshotSchemaCodec.deserialize(
          Fs.readFileSync(files.solana, "utf8")
        ),
        stakerIdentity = holders.find(
          holder => holder.templateAddress === StakerAddress
        ).identity,
        solanaStakerIdentity = holders.find(
          holder => holder.templateAddress === SolanaStakerAddress
        ).identity
      expect(ethereum.stakers[0].pubkey).toBe(stakerIdentity.pubkey)
      expect(solana.balances[0].address).toBe(solanaStakerIdentity.address)
      // The written exports are exactly what the bootstrap imports: the plan derives the
      // positions keyed by the substituted keys.
      const plan = WireLcoImportTool.createPlan({
        ethereum: {
          bootstrapJsonFile: files.ethereum,
          nativePriceUsd: null,
          highestTranchePriceUsd: null,
          pool: null
        },
        solana: {
          bootstrapJsonFile: files.solana,
          nativePriceUsd: null,
          highestTranchePriceUsd: null,
          pool: null
        },
        dclaimFundingAccount: null
      })
      expect(plan.ethereum.syndications.map(spec => spec.pubkey)).toContain(
        stakerIdentity.pubkey
      )
      expect(plan.solana.syndications.map(spec => spec.pubkey)).toEqual([
        solanaStakerIdentity.pubkey
      ])
    })

    it("writeExport creates the export's directory and writes it indented", () => {
      const file = Path.join(directory, "nested", "deeper", "export.json")
      WireLcoExportTool.writeExport(file, ethereumSnapshot())
      expect(Fs.readFileSync(file, "utf8")).toBe(
        JSON.stringify(ethereumSnapshot(), null, WireLcoExportTool.ExportIndent)
      )
    })

    it("readTemplate parses a committed template verbatim, without validating it", () => {
      const file = Path.join(directory, "template.json")
      Fs.writeFileSync(file, JSON.stringify({ stakers: [], anything: true }))
      expect(WireLcoExportTool.readTemplate(file)).toEqual({
        stakers: [],
        anything: true
      })
    })
  })
})
