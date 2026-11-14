import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { Connection, Keypair, PublicKey } from "@solana/web3.js"
import type { ExternalOutpostConfigSolana } from "@wireio/cluster-tool-shared"
import { SolanaClient } from "@wireio/cluster-tool/clients/solana"
import { BindConfigProvider } from "@wireio/cluster-tool/config"
import {
  SolanaOutpostProgramTool,
  SolanaOutpostTarget
} from "@wireio/cluster-tool/tools/solana"
import { toURL } from "@wireio/cluster-tool/utils"
import { fixtureContext } from "../../config/clusterBuildContextFixture.js"

/** Stage a wire-solana tree with a committed keypair per genesis program. */
function stageProgramKeys(solanaPath: string): Map<string, PublicKey> {
  const ids = new Map<string, PublicKey>()
  Fs.mkdirSync(
    Path.join(solanaPath, SolanaOutpostProgramTool.KeysSubdirectory),
    { recursive: true }
  )
  SolanaOutpostProgramTool.GenesisAnchorPrograms.forEach(program => {
    const keypair = Keypair.generate()
    Fs.writeFileSync(
      SolanaOutpostProgramTool.programKeypairFile(solanaPath, program),
      JSON.stringify([...keypair.secretKey])
    )
    ids.set(program, keypair.publicKey)
  })
  return ids
}

/** The finalized slot a document was generated at. */
const AsOfSlot = 56_789

/** An external config's Solana outpost, with or without an endpoint / mints / as-of slot. */
function externalSolana(
  programId: PublicKey,
  rpcUrl?: string,
  mints?: ExternalOutpostConfigSolana["mints"],
  asOfSlot?: ExternalOutpostConfigSolana["asOfSlot"]
): ExternalOutpostConfigSolana {
  return {
    programId: programId.toBase58(),
    ...(rpcUrl != null ? { rpcUrl } : {}),
    ...(mints != null ? { mints } : {}),
    ...(asOfSlot != null ? { asOfSlot } : {})
  }
}

describe("SolanaOutpostTarget", () => {
  let solanaPath: string
  let programIds: Map<string, PublicKey>
  let rpcUrl: string

  beforeAll(async () => {
    solanaPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), "solana-target-"))
    programIds = stageProgramKeys(solanaPath)
    rpcUrl = toURL(
      await BindConfigProvider.findAvailable(BindConfigProvider.DefaultSolanaRpc)
    )
  })
  afterAll(() => {
    Fs.rmSync(solanaPath, { recursive: true, force: true })
  })

  it("fromContext derives the context's connection, solanaPath and the committed program id", () => {
    const ctx = fixtureContext({ solanaPath }),
      target = SolanaOutpostTarget.fromContext(ctx)
    expect(target.connection).toBe(ctx.solana.connection)
    expect(target.solanaPath).toBe(solanaPath)
    expect(
      target.programId.equals(
        programIds.get(SolanaOutpostProgramTool.AnchorProgram.liqsolCore)
      )
    ).toBe(true)
    expect("mints" in target).toBe(false)
    expect("asOfSlot" in target).toBe(false)
  })

  it("fromContext refuses an external-outpost cluster, as every runner did before it", () => {
    const external = fixtureContext({
      solanaPath,
      externalOutposts: {
        ethereum: {
          chainId: 1,
          outpostAddresses: {
            OPP: "0x1111111111111111111111111111111111111111",
            OPPInbound: "0x1111111111111111111111111111111111111111",
            BAR: "0x1111111111111111111111111111111111111111"
          }
        },
        solana: externalSolana(Keypair.generate().publicKey)
      }
    })
    expect(() => SolanaOutpostTarget.fromContext(external)).toThrow(
      /never contacts an external Solana outpost/
    )
  })

  it("fromContext throws the build remediation when the program keypair is absent", () => {
    const emptyPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), "solana-target-empty-"))
    try {
      expect(() =>
        SolanaOutpostTarget.fromContext(fixtureContext({ solanaPath: emptyPath }))
      ).toThrow(/program keypair missing/)
    } finally {
      Fs.rmSync(emptyPath, { recursive: true, force: true })
    }
  })

  it("fromExternalOutpost composes the config's program id + mints over the connection and tree", () => {
    const programId = Keypair.generate().publicKey,
      mint = Keypair.generate().publicKey.toBase58(),
      connection = SolanaOutpostTarget.createConnection(rpcUrl),
      target = SolanaOutpostTarget.fromExternalOutpost(
        externalSolana(programId, rpcUrl, [{ code: 7, mint, decimals: 9 }]),
        solanaPath,
        connection
      )
    expect(target.connection).toBe(connection)
    expect(target.solanaPath).toBe(solanaPath)
    expect(target.programId.equals(programId)).toBe(true)
    expect(target.mints).toEqual([{ code: 7, mint, decimals: 9 }])
    expect(
      "mints" in
        SolanaOutpostTarget.fromExternalOutpost(
          externalSolana(programId, rpcUrl),
          solanaPath,
          connection
        )
    ).toBe(false)
  })

  it("fromExternalOutpost carries the document's asOfSlot, and leaves it absent when the document has none", () => {
    const programId = Keypair.generate().publicKey,
      connection = SolanaOutpostTarget.createConnection(rpcUrl)
    expect(
      SolanaOutpostTarget.fromExternalOutpost(
        externalSolana(programId, rpcUrl, undefined, AsOfSlot),
        solanaPath,
        connection
      ).asOfSlot
    ).toBe(AsOfSlot)
    expect(
      "asOfSlot" in
        SolanaOutpostTarget.fromExternalOutpost(
          externalSolana(programId, rpcUrl),
          solanaPath,
          connection
        )
    ).toBe(false)
  })

  it("createConnection dials at the harness commitment", () => {
    const connection = SolanaOutpostTarget.createConnection(rpcUrl)
    expect(connection).toBeInstanceOf(Connection)
    expect(connection.commitment).toBe(SolanaClient.DefaultCommitment)
    expect(connection.rpcEndpoint).toBe(rpcUrl)
  })

  it("assertRpcUrl demands the endpoint a cluster-less command dials", () => {
    const programId = Keypair.generate().publicKey
    expect(
      SolanaOutpostTarget.assertRpcUrl(externalSolana(programId, rpcUrl))
    ).toBe(rpcUrl)
    expect(() =>
      SolanaOutpostTarget.assertRpcUrl(externalSolana(programId))
    ).toThrow(/must carry solana\.rpcUrl/)
    expect(() =>
      SolanaOutpostTarget.assertRpcUrl(externalSolana(programId, ""))
    ).toThrow(/must carry solana\.rpcUrl/)
  })

  it("is() / resolve() tell a target from a build context and hand back the target either way", () => {
    const ctx = fixtureContext({ solanaPath }),
      target = SolanaOutpostTarget.fromExternalOutpost(
        externalSolana(Keypair.generate().publicKey, rpcUrl),
        solanaPath,
        SolanaOutpostTarget.createConnection(rpcUrl)
      )
    expect(SolanaOutpostTarget.is(target)).toBe(true)
    expect(SolanaOutpostTarget.is(ctx)).toBe(false)
    expect(SolanaOutpostTarget.is(null)).toBe(false)
    expect(SolanaOutpostTarget.is({ connection: null })).toBe(false)
    expect(SolanaOutpostTarget.resolve(target)).toBe(target)
    expect(SolanaOutpostTarget.resolve(ctx).connection).toBe(
      ctx.solana.connection
    )
  })
})
