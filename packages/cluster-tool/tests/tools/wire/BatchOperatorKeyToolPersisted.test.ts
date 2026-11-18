import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { OperatorType } from "@wireio/opp-typescript-models"
import { Constants } from "@wireio/cluster-tool"
import { EthereumWallet } from "@wireio/cluster-tool/clients/ethereum"
import { KeyGenerator, WireWallet } from "@wireio/cluster-tool/clients/wire"
import { SolanaFundingTool } from "@wireio/cluster-tool/tools/solana"
import { BatchOperatorKeyTool } from "@wireio/cluster-tool/tools/wire"
import {
  ethereumSigner,
  solanaKeypair,
  solanaNativePublicKey
} from "@wireio/cluster-tool/utils"

/** The three bootstrap batch operators a pre-funded launch pre-creates. */
const Labels = Constants.batchOperatorLabels(3)
/** A tooling-less generation context: K1 / ED / EM need no build. */
const keyContext = KeyGenerator.context()

describe("BatchOperatorKeyTool persisted (KEY custody) identities", () => {
  let dataPath: string

  beforeEach(() => {
    dataPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), "batchop-keys-"))
  })

  afterEach(() => {
    Fs.rmSync(dataPath, { recursive: true, force: true })
  })

  it("createPersisted persists every curve of every operator under its label handle", async () => {
    const operators = await BatchOperatorKeyTool.createPersisted(
      dataPath,
      Labels,
      keyContext
    )
    expect(operators.map(operator => operator.label)).toEqual(Labels)
    operators.forEach(operator => {
      expect(operator).toMatchObject({
        account: operator.label,
        publicationLabel: operator.label,
        type: OperatorType.BATCH
      })
      expect(WireWallet.hasKey(dataPath, operator.label)).toBe(true)
      expect(EthereumWallet.hasWallet(dataPath, operator.label)).toBe(true)
      expect(
        Fs.existsSync(SolanaFundingTool.keypairFile(dataPath, operator.label))
      ).toBe(true)
      expect(operator.wire).toEqual(WireWallet.loadKeyPair(dataPath, operator.label))
      expect(operator.ethereum).toEqual(
        EthereumWallet.loadKeyPair(dataPath, operator.label)
      )
      expect(solanaNativePublicKey(operator.solana)).toBe(
        SolanaFundingTool.loadKeypair(dataPath, operator.label).publicKey.toBase58()
      )
    })
  })

  it("mints a DISTINCT random identity per operator whose material signs on both outposts", async () => {
    const operators = await BatchOperatorKeyTool.createPersisted(
      dataPath,
      Labels,
      keyContext
    )
    expect(new Set(operators.map(operator => operator.wire.publicKey)).size).toBe(
      Labels.length
    )
    expect(new Set(operators.map(operator => operator.ethereum.address)).size).toBe(
      Labels.length
    )
    expect(new Set(operators.map(operator => operator.solana.publicKey)).size).toBe(
      Labels.length
    )
    const [first] = operators,
      signer = await ethereumSigner(first.ethereum)
    expect(await signer.getAddress()).toBe(first.ethereum.address)
    expect(solanaKeypair(first.solana).publicKey.toBase58()).toBe(
      solanaNativePublicKey(first.solana)
    )
  })

  it("is idempotent — a re-run reads every handle back instead of minting another identity", async () => {
    const first = await BatchOperatorKeyTool.createPersisted(
        dataPath,
        Labels,
        keyContext
      ),
      again = await BatchOperatorKeyTool.createPersisted(
        dataPath,
        Labels,
        keyContext
      )
    expect(again).toEqual(first)
  })

  it("loadPersisted returns exactly what createPersisted persisted", async () => {
    const created = await BatchOperatorKeyTool.createPersisted(
      dataPath,
      Labels,
      keyContext
    )
    expect(BatchOperatorKeyTool.loadPersisted(dataPath, Labels)).toEqual(created)
    expect(BatchOperatorKeyTool.loadPersisted(dataPath, [Labels[1]])).toEqual([
      created[1]
    ])
  })

  it("loadPersisted refuses a handle that was never persisted — the adoptOnly negative control", async () => {
    await BatchOperatorKeyTool.createPersisted(dataPath, Labels.slice(0, 2), keyContext)
    expect(() => BatchOperatorKeyTool.loadPersisted(dataPath, Labels)).toThrow(
      /"batchop\.c" not found/
    )
    expect(() => BatchOperatorKeyTool.loadPersisted(dataPath, [Labels[2]])).toThrow(
      /not found/
    )
  })

  it("refuses a label that is not a bootstrap batch operator's, before persisting anything", async () => {
    await expect(
      BatchOperatorKeyTool.createPersisted(dataPath, ["uwrit.a"], keyContext)
    ).rejects.toThrow(/"uwrit\.a" is not a bootstrap batch-operator label/)
    expect(() => BatchOperatorKeyTool.loadPersisted(dataPath, ["uwrit.a"])).toThrow(
      /is not a bootstrap batch-operator label/
    )
    expect(Fs.readdirSync(dataPath)).toEqual([])
  })
})
