import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { OperatorType } from "@wireio/opp-typescript-models"
import { KeyType } from "@wireio/sdk-core"
import {
  ExternalClusterConfigSchemaCodec,
  SignatureProviderType,
  type ExternalClusterConfig
} from "@wireio/cluster-tool-shared"
import { ExternalClusterConfigProvider } from "@wireio/cluster-tool/config"

const config: ExternalClusterConfig = {
  bindings: {
    kiod: { address: "10.0.0.1", port: 8900 },
    nodeop: {
      address: "10.0.0.1",
      ports: {
        bios: { http: 8888, p2p: 9876 },
        producers: [{ http: 8988, p2p: 9976 }],
        batch: [],
        underwriters: []
      }
    },
    anvil: { address: "10.0.0.2", port: 8545 },
    solana: {
      address: "10.0.0.3",
      ports: {
        http: 8899,
        faucet: 9900,
        gossip: 8001,
        dynamicRange: { first: 8100, last: 8200 }
      }
    },
    debuggingServer: { address: "10.0.0.1", port: 9901 }
  },
  accounts: {
    operators: [
      {
        accountName: "batchop1",
        type: OperatorType.BATCH,
        keyProviders: [
          {
            providerType: SignatureProviderType.KEY,
            type: KeyType.K1,
            publicKey: "PUB_K1_x",
            privateKey: "PVT_K1_y"
          }
        ]
      }
    ]
  },
  wire: { epochDurationSec: 60, genesisFile: "genesis.json" },
  ethereum: {
    addressFile: "outpost-addrs.json",
    abiFiles: ["eth-abis/OPP.json"],
    chainId: 1
  },
  solana: { idlFile: "solana-idls/opp.json" }
}

describe("ExternalClusterConfigProvider", () => {
  let dir: string
  beforeEach(() => {
    dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "extcfg-"))
  })
  afterEach(() => {
    Fs.rmSync(dir, { recursive: true, force: true })
  })

  function writeConfig(payload: ExternalClusterConfig): string {
    const file = Path.join(dir, "external-cluster-config.json")
    Fs.writeFileSync(file, ExternalClusterConfigSchemaCodec.serialize(payload))
    return file
  }

  it("load resolves relative *File references against the config file dir", () => {
    const loaded = ExternalClusterConfigProvider.load(writeConfig(config))
    expect(loaded.wire.genesisFile).toBe(Path.join(dir, "genesis.json"))
    expect(loaded.ethereum.addressFile).toBe(Path.join(dir, "outpost-addrs.json"))
    expect(loaded.ethereum.abiFiles[0]).toBe(Path.join(dir, "eth-abis/OPP.json"))
    expect(loaded.solana?.idlFile).toBe(Path.join(dir, "solana-idls/opp.json"))
  })

  it("load leaves absolute references untouched", () => {
    const file = writeConfig({
      ...config,
      ethereum: { ...config.ethereum, addressFile: "/abs/outpost-addrs.json" }
    })
    expect(ExternalClusterConfigProvider.load(file).ethereum.addressFile).toBe(
      "/abs/outpost-addrs.json"
    )
  })

  it("deserialize decodes without resolving references", () => {
    const decoded = ExternalClusterConfigProvider.deserialize(
      ExternalClusterConfigSchemaCodec.serialize(config)
    )
    expect(decoded.ethereum.addressFile).toBe("outpost-addrs.json")
    expect(decoded.accounts.operators[0].type).toBe(OperatorType.BATCH)
  })

  it("throws for a missing file", () => {
    expect(() =>
      ExternalClusterConfigProvider.load(Path.join(dir, "nope.json"))
    ).toThrow(/not found/)
  })

  it("throws for a schema-invalid payload", () => {
    expect(() => ExternalClusterConfigProvider.deserialize("{}")).toThrow()
  })
})
