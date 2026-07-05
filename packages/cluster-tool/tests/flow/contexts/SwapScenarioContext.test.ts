import { SysioContracts } from "@wireio/sdk-core"
import { SwapScenarioContext } from "@wireio/cluster-tool/flow"
import { getLogger } from "@wireio/cluster-tool/logging"
import type { WireClient } from "@wireio/cluster-tool/clients/wire"
import { fixtureConfig } from "../../config/clusterConfigFixture.js"

const {
  SysioContractName,
  SysioReservChainkind,
  SysioReservReservestatus,
  SysioUwritAttestationtype,
  SysioUwritUnderwriterequeststatus
} = SysioContracts

const EthereumChain = 100
const SolanaChain = 200
const EthToken = 101
const SolToken = 201
const PrimaryReserve = 1

/** A complete `reserves` row with zero defaults; override the fields under test. */
function reserveRow(
  overrides: Partial<SysioContracts.SysioReservReserveRowType>
): SysioContracts.SysioReservReserveRowType {
  return {
    chain_code: { value: 0 },
    token_code: { value: 0 },
    reserve_code: { value: 0 },
    name: "",
    description: "",
    status: SysioReservReservestatus.RESERVE_STATUS_ACTIVE,
    reserve_chain_amount: 0,
    reserve_wire_amount: 0,
    source_token_precision: 0,
    connector_weight_bps: 0,
    creator_addr: { kind: SysioReservChainkind.CHAIN_KIND_UNKNOWN, address: "" },
    requested_wire_amount: 0,
    external_token_amount: 0,
    registered_at_ms: 0,
    activated_at_ms: 0,
    cancelled_at_ms: 0,
    is_private: false,
    owner: "",
    creator_pub_key: "",
    ...overrides
  }
}

/** A complete `uwreqs` row with zero defaults; override the fields under test. */
function uwreqRow(
  overrides: Partial<SysioContracts.SysioUwritUwRequestTType>
): SysioContracts.SysioUwritUwRequestTType {
  return {
    id: 0,
    type: SysioUwritAttestationtype.ATTESTATION_TYPE_UNSPECIFIED,
    status: SysioUwritUnderwriterequeststatus.UNDERWRITE_REQUEST_STATUS_PENDING,
    src_chain_code: { value: 0 },
    src_token_code: { value: 0 },
    src_reserve_code: { value: 0 },
    src_amount: 0,
    dst_chain_code: { value: 0 },
    dst_token_code: { value: 0 },
    dst_reserve_code: { value: 0 },
    dst_amount: 0,
    variance_tolerance_bps: 0,
    source_tx_id: "",
    depositor: "",
    commits_by: [],
    winner: "",
    committed_at_ms: 0,
    settled_at_ms: 0,
    expires_at_epoch: 0,
    attestation_inbound_data: "",
    attestation_outbound_data: "",
    ...overrides
  }
}

/** A complete `locks` row with zero defaults; override the fields under test. */
function lockRow(
  overrides: Partial<SysioContracts.SysioUwritLockEntryType>
): SysioContracts.SysioUwritLockEntryType {
  return {
    lock_id: 0,
    uwreq_id: 0,
    underwriter: "",
    chain_code: { value: 0 },
    token_code: { value: 0 },
    reserve_code: { value: 0 },
    amount: 0,
    created_at_ms: 0,
    expires_at_ms: 0,
    ...overrides
  }
}

/** Table fixtures served by the stubbed typed accessors. */
interface TableFixtures {
  reserves: SysioContracts.SysioReservReserveRowType[]
  uwreqs: SysioContracts.SysioUwritUwRequestTType[]
  locks: SysioContracts.SysioUwritLockEntryType[]
}

/** A context whose `wire.getSysioContract` serves the fixtures (reads only). */
function newContext(fixtures: TableFixtures): SwapScenarioContext {
  const context = new SwapScenarioContext(fixtureConfig(), getLogger("swap-ctx-test"))
  const table = <Row>(rows: Row[]) => ({
    query: async () => ({ rows, more: false })
  })
  const clientByName = {
    [SysioContractName.reserv]: { tables: { reserves: table(fixtures.reserves) } },
    [SysioContractName.uwrit]: {
      tables: { uwreqs: table(fixtures.uwreqs), locks: table(fixtures.locks) }
    }
  }
  jest
    .spyOn(context, "wire", "get")
    .mockReturnValue({
      getSysioContract: (name: SysioContracts.SysioContractName) => clientByName[name]
    } as WireClient)
  return context
}

describe("SwapScenarioContext", () => {
  const fixtures: TableFixtures = {
    reserves: [
      reserveRow({
        chain_code: { value: EthereumChain },
        token_code: { value: EthToken },
        reserve_code: { value: PrimaryReserve },
        reserve_chain_amount: 1_000,
        reserve_wire_amount: 2_000
      }),
      reserveRow({
        chain_code: { value: SolanaChain },
        token_code: { value: SolToken },
        reserve_code: { value: PrimaryReserve },
        reserve_chain_amount: 3_000,
        reserve_wire_amount: 4_000
      })
    ],
    uwreqs: [
      uwreqRow({
        id: 7,
        src_chain_code: { value: EthereumChain },
        dst_chain_code: { value: SolanaChain }
      })
    ],
    locks: [
      lockRow({ lock_id: 1, uwreq_id: 7, chain_code: { value: EthereumChain } }),
      lockRow({ lock_id: 2, uwreq_id: 7, chain_code: { value: SolanaChain } }),
      lockRow({ lock_id: 3, uwreq_id: 9 })
    ]
  }

  describe("reserveBook", () => {
    it("returns the matching reserve's (chain, wire) book as bigints", async () => {
      const book = await newContext(fixtures).reserveBook(
        EthereumChain,
        EthToken,
        PrimaryReserve
      )
      expect(book).toEqual({ chain: 1_000n, wire: 2_000n })
    })
    it("throws when no reserve matches the triple", async () => {
      await expect(
        newContext(fixtures).reserveBook(999, EthToken, PrimaryReserve)
      ).rejects.toThrow(/not found/)
    })
  })

  describe("uwreq", () => {
    it("finds the request by its (source, destination) chain pair", async () => {
      const request = await newContext(fixtures).uwreq(EthereumChain, SolanaChain)
      expect(request?.id).toBe(7)
    })
    it("is empty when the depot has not created the request", async () => {
      expect(
        await newContext(fixtures).uwreq(SolanaChain, EthereumChain)
      ).toBeUndefined()
    })
  })

  describe("locksForUwreq", () => {
    it("returns every lock referencing the request id", async () => {
      const locks = await newContext(fixtures).locksForUwreq(7)
      expect(locks.map(lock => lock.lock_id)).toEqual([1, 2])
    })
    it("is empty for an unknown request id", async () => {
      expect(await newContext(fixtures).locksForUwreq(42)).toEqual([])
    })
  })
})
