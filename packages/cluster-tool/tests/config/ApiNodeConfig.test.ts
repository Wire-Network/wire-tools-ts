import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { DefaultChainStateDbSizeMb } from "@wireio/cluster-tool-shared"
import {
  ApiNodeConfig,
  type ApiNodeOptions,
  createApiNodeDefaultOptions
} from "@wireio/cluster-tool/config"

/** A minimal, always-valid options set the invariant cases mutate one field of. */
const ValidHttpServerAddress = "0.0.0.0:8888"

describe("ApiNodeConfig", () => {
  let dir: string

  beforeAll(() => {
    dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "api-node-config-"))
  })
  afterAll(() => {
    Fs.rmSync(dir, { recursive: true, force: true })
  })

  /** Valid caller options rooted in the suite's tmpdir. */
  function validOptions(overrides: ApiNodeOptions = {}): ApiNodeOptions {
    return {
      outputPath: Path.join(dir, "out"),
      httpServerAddress: ValidHttpServerAddress,
      ...overrides
    }
  }

  describe("createApiNodeDefaultOptions", () => {
    it("returns every namespace constant, plus the shared chain-state size", () => {
      const defaultOptions = createApiNodeDefaultOptions()
      expect(defaultOptions.p2pPeerAddresses).toEqual([])
      expect(defaultOptions.chainStateDbSizeMb).toBe(DefaultChainStateDbSizeMb)
      expect(defaultOptions.tuning).toEqual({
        transactionFinalityStatusMaxStorageSizeGb:
          ApiNodeConfig.DefaultTransactionFinalityStatusMaxStorageSizeGb,
        enableAccountQueries: ApiNodeConfig.DefaultEnableAccountQueries,
        httpMaxInFlightRequests: ApiNodeConfig.DefaultHttpMaxInFlightRequests,
        httpThreads: ApiNodeConfig.DefaultHttpThreads,
        agentName: ApiNodeConfig.DefaultAgentName
      })
    })

    it("pins the ticket-baseline default VALUES (a change here changes every emitted config.ini)", () => {
      expect(
        ApiNodeConfig.DefaultTransactionFinalityStatusMaxStorageSizeGb
      ).toBe(10)
      expect(ApiNodeConfig.DefaultEnableAccountQueries).toBe(true)
      expect(ApiNodeConfig.DefaultHttpMaxInFlightRequests).toBe(100)
      expect(ApiNodeConfig.DefaultHttpThreads).toBe(4)
      expect(ApiNodeConfig.DefaultAgentName).toBe("wire-api-node")
      expect(DefaultChainStateDbSizeMb).toBe(1_024)
    })

    it("hands back a FRESH tuning group each call (no shared mutable default)", () => {
      const first = createApiNodeDefaultOptions(),
        second = createApiNodeDefaultOptions()
      expect(first.tuning).not.toBe(second.tuning)
      expect(first.p2pPeerAddresses).not.toBe(second.p2pPeerAddresses)
    })
  })

  describe("resolve", () => {
    it("applies every default when the caller supplies only the required fields", () => {
      const config = ApiNodeConfig.resolve(validOptions())
      expect(config.chainStateDbSizeMb).toBe(DefaultChainStateDbSizeMb)
      expect(config.p2pPeerAddresses).toEqual([])
      expect(config.genesisJsonFile).toBeUndefined()
      expect(config.tuning).toEqual(createApiNodeDefaultOptions().tuning)
    })

    it("lets the caller win over every default", () => {
      const config = ApiNodeConfig.resolve(
        validOptions({
          p2pPeerAddresses: ["10.0.0.5:9876", "10.0.0.6:9876"],
          chainStateDbSizeMb: 8_192,
          tuning: {
            transactionFinalityStatusMaxStorageSizeGb: 25,
            enableAccountQueries: false,
            httpMaxInFlightRequests: 500,
            httpThreads: 16,
            agentName: "custom-api"
          }
        })
      )
      expect(config.chainStateDbSizeMb).toBe(8_192)
      expect(config.p2pPeerAddresses).toEqual([
        "10.0.0.5:9876",
        "10.0.0.6:9876"
      ])
      expect(config.tuning).toEqual({
        transactionFinalityStatusMaxStorageSizeGb: 25,
        enableAccountQueries: false,
        httpMaxInFlightRequests: 500,
        httpThreads: 16,
        agentName: "custom-api"
      })
    })

    it("keeps the untouched sub-defaults when `tuning` is PARTIAL (the second shallow pass)", () => {
      const config = ApiNodeConfig.resolve(
        validOptions({ tuning: { httpThreads: 32 } })
      )
      expect(config.tuning.httpThreads).toBe(32)
      // Everything the caller did NOT name survives — a single shallow
      // `defaults` would have replaced the whole group and left these unset.
      expect(config.tuning.agentName).toBe(ApiNodeConfig.DefaultAgentName)
      expect(config.tuning.httpMaxInFlightRequests).toBe(
        ApiNodeConfig.DefaultHttpMaxInFlightRequests
      )
      expect(config.tuning.enableAccountQueries).toBe(
        ApiNodeConfig.DefaultEnableAccountQueries
      )
      expect(config.tuning.transactionFinalityStatusMaxStorageSizeGb).toBe(
        ApiNodeConfig.DefaultTransactionFinalityStatusMaxStorageSizeGb
      )
    })

    it("does NOT resurrect default peers under a caller-supplied list (defaultsDeep would)", () => {
      const config = ApiNodeConfig.resolve(
        validOptions({ p2pPeerAddresses: ["10.0.0.5:9876"] })
      )
      expect(config.p2pPeerAddresses).toEqual(["10.0.0.5:9876"])
    })

    it("does not mutate the caller's options object", () => {
      const options = validOptions({ tuning: { httpThreads: 32 } })
      ApiNodeConfig.resolve(options)
      expect(options.chainStateDbSizeMb).toBeUndefined()
      expect(options.p2pPeerAddresses).toBeUndefined()
      expect(options.tuning).toEqual({ httpThreads: 32 })
    })

    it("accepts a genesis file that exists and carries it through", () => {
      const genesisFile = Path.join(dir, "genesis.json")
      Fs.writeFileSync(genesisFile, JSON.stringify({ initial_key: "x" }))
      expect(
        ApiNodeConfig.resolve(validOptions({ genesisJsonFile: genesisFile }))
          .genesisJsonFile
      ).toBe(genesisFile)
    })

    it("REJECTS a missing outputPath", () => {
      expect(() =>
        ApiNodeConfig.resolve({ httpServerAddress: ValidHttpServerAddress })
      ).toThrow(/outputPath is required/)
    })

    it("REJECTS a malformed httpServerAddress", () => {
      expect(() =>
        ApiNodeConfig.resolve(validOptions({ httpServerAddress: "0.0.0.0" }))
      ).toThrow(/httpServerAddress must be <address>:<port>/)
      expect(() =>
        ApiNodeConfig.resolve(
          validOptions({ httpServerAddress: "0.0.0.0:not-a-port" })
        )
      ).toThrow(/httpServerAddress must be <address>:<port>/)
    })

    it("REJECTS an out-of-range httpServerAddress port", () => {
      expect(() =>
        ApiNodeConfig.resolve(validOptions({ httpServerAddress: "0.0.0.0:0" }))
      ).toThrow(/httpServerAddress port must be/)
      expect(() =>
        ApiNodeConfig.resolve(
          validOptions({ httpServerAddress: "0.0.0.0:99999" })
        )
      ).toThrow(/httpServerAddress port must be/)
    })

    it("REJECTS a malformed peer entry, naming its index", () => {
      expect(() =>
        ApiNodeConfig.resolve(
          validOptions({ p2pPeerAddresses: ["10.0.0.5:9876", "10.0.0.6"] })
        )
      ).toThrow(/p2pPeerAddresses\[1\] must be <address>:<port>/)
    })

    it("REJECTS a non-positive chainStateDbSizeMb", () => {
      expect(() =>
        ApiNodeConfig.resolve(validOptions({ chainStateDbSizeMb: 0 }))
      ).toThrow(/chainStateDbSizeMb must be > 0/)
      expect(() =>
        ApiNodeConfig.resolve(validOptions({ chainStateDbSizeMb: -1 }))
      ).toThrow(/chainStateDbSizeMb must be > 0/)
    })

    it("REJECTS a genesis file that is not on disk", () => {
      expect(() =>
        ApiNodeConfig.resolve(
          validOptions({ genesisJsonFile: Path.join(dir, "absent.json") })
        )
      ).toThrow(/genesisJsonFile not found/)
    })

    it("accepts a bracketed IPv6 endpoint (the port stays unambiguous)", () => {
      expect(
        ApiNodeConfig.resolve(validOptions({ httpServerAddress: "[::1]:8888" }))
          .httpServerAddress
      ).toBe("[::1]:8888")
    })

    it.each(["host:8888", "10.0.0.1:80", "[::1]:8888"])(
      "accepts the scheme-less endpoint %s for BOTH the server address and a peer",
      endpoint => {
        expect(
          ApiNodeConfig.resolve(validOptions({ httpServerAddress: endpoint }))
            .httpServerAddress
        ).toBe(endpoint)
        expect(
          ApiNodeConfig.resolve(validOptions({ p2pPeerAddresses: [endpoint] }))
            .p2pPeerAddresses
        ).toEqual([endpoint])
      }
    )

    it("REJECTS a URL where an <address>:<port> is required", () => {
      // nodeop takes the scheme-less form only, so `http://…` has to fail here
      // rather than at daemon startup on the deployment host. The shared
      // `netUtils.assertEndpoint` is what enforces it for both fields.
      expect(() =>
        ApiNodeConfig.resolve(
          validOptions({ httpServerAddress: "http://host:8888" })
        )
      ).toThrow(/httpServerAddress must be <address>:<port>/)
      expect(() =>
        ApiNodeConfig.resolve(
          validOptions({ p2pPeerAddresses: ["http://peer.example:9876"] })
        )
      ).toThrow(/p2pPeerAddresses\[0\] must be <address>:<port>/)
    })

    it("keeps the ApiNodeConfig prefix on every endpoint failure after the netUtils move", () => {
      expect(() =>
        ApiNodeConfig.resolve(validOptions({ httpServerAddress: "0.0.0.0" }))
      ).toThrow(/ApiNodeConfig: httpServerAddress must be/)
      expect(() =>
        ApiNodeConfig.resolve(validOptions({ chainStateDbSizeMb: 0 }))
      ).toThrow(/ApiNodeConfig: chainStateDbSizeMb must be > 0/)
    })

    it("no longer re-declares the endpoint pattern or port bounds", () => {
      // MINOR-8: `netUtils` is the single host/URL authority; a survivor here
      // would be a second, drift-prone copy of the same validation.
      expect("EndpointPattern" in ApiNodeConfig).toBe(false)
      expect("MinimumPort" in ApiNodeConfig).toBe(false)
      expect("MaximumPort" in ApiNodeConfig).toBe(false)
      // Positive control: the namespace itself is still populated.
      expect("DefaultAgentName" in ApiNodeConfig).toBe(true)
    })
  })
})
